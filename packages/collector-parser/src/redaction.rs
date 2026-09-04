// SPDX-License-Identifier: Apache-2.0
// Vendored and refactored from otto-parser/src/parser/redaction.rs (~/src/otto, 2026-05-25).
// The drop/mask policy and pattern set are aligned with apps/agent-ingest/src/redaction.ts (task 2b)
// so the Collector (primary redactor) and the ingest Worker (backstop) redact the shared canary
// corpus identically — the two trust-boundary layers must not drift.
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Field-level secret/PII redaction. `redact_field` is the unit the parser runs over every free-text
//! excerpt before it leaves the machine; its drop-vs-mask decision and counter mirror the TS
//! `redactField` so the same `fixtures/redaction-canary.json` passes on both sides.

use std::sync::LazyLock;

use regex::{Captures, Regex};

const REDACTED: &str = "[REDACTED]";

/// Outcome of redacting one free-text field.
///
/// `value` is the cleaned text, or empty when a high-confidence credential forced a whole-field drop
/// (a secret surviving anywhere makes the field untrustworthy). `dropped` is the number of sensitive
/// hits the caller folds into a fact's `dropped_sensitive` counter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redaction {
    pub value: String,
    pub dropped: u32,
}

// --- Structure-preserving masks (keep the field, neutralize the secret in place) ---

/// `Authorization: Bearer <token>` — masked first so the token can't trip a `sk-` drop matcher and
/// discard a header the canary says to keep. The `regex` crate has no lookahead, but the char class
/// excludes whitespace, so `+` stops at the token boundary on its own.
static BEARER_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*").expect("bearer pattern"));

/// `/Users/<name>/` or `/home/<name>/` — masks the username, keeps the path shape.
static HOME_PATH_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(/(?:Users|home)/)([^/\s]+)").expect("home path pattern"));

// --- Drop matchers (a match withholds the whole field; high-confidence, low-false-positive only) ---

static DROP_MATCHERS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // AWS access key id (AKIA/ASIA + 16 base32 chars).
        r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        // AWS secret access key assignment (40-char base64-ish value).
        r"(?i)aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+]{40}",
        // GitHub fine-grained PAT (distinct prefix, may contain `_`).
        r"\bgithub_pat_[A-Za-z0-9_]{20,}\b",
        // GitHub classic PAT / OAuth / refresh / server tokens.
        r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b",
        // OpenAI-style API key (`sk-` + >= 20 chars). Bearer masking runs first so headers are kept.
        r"\bsk-[A-Za-z0-9-]{20,}\b",
        // Slack tokens (bot/user/app/refresh/legacy).
        r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b",
        // Credentials embedded in a URL userinfo (`scheme://user:password@host`).
        r"://[^:/?#@\s]+:[^@/?#\s]+@",
        // JWT (three base64url segments).
        r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
        // PEM private key header (RSA/EC/OPENSSH/PKCS8).
        r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----",
        // `$HOME`-rooted path (home dir and the file it points at must not survive).
        r"\$HOME(?:/\S+)?",
    ]
    .into_iter()
    .map(|src| Regex::new(src).expect("drop matcher"))
    .collect()
});

// --- Residual PII masks (run last, only on a field we are keeping) ---

static CARD_CANDIDATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{0,7}|\d{13,19})\b")
        .expect("card pattern")
});
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").expect("email")
});
static SSN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").expect("ssn"));
static IPV4: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b")
        .expect("ipv4")
});
/// US-style phone numbers. The TS pattern uses a `(?<![A-Za-z0-9])` lookbehind the `regex` crate
/// can't express, so capture the leading boundary char and re-emit it around the mask instead.
static PHONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[^A-Za-z0-9])((?:\+1\s?)?(?:\(\d{3}\)\s*|\d{3}[-.\s]?)\d{3}[-.\s]?\d{4})\b")
        .expect("phone")
});
/// JSON-ish quoted value after a sensitive key — masks the value, keeps the key and quotes.
static SENSITIVE_JSON_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)("(?:api_key|apikey|access_token|refresh_token|client_secret|password|secret|token|authorization|auth_token|private_key|x_api_key|x-api-key)"\s*:\s*")((?:[^"\\]|\\.)*)(")"#,
    )
    .expect("sensitive json value")
});

/// Masks or drops sensitive substrings in a single free-text field.
///
/// Pass order is load-bearing: structure-preserving masks first (so a `Bearer sk-...` header is kept,
/// not dropped), then the credential drop pass on the still-raw text (the PII pass would mangle a
/// token's shape so the drop matcher could no longer recognize it), then residual PII on a kept field.
pub fn redact_field(input: &str) -> Redaction {
    if input.is_empty() {
        return Redaction {
            value: String::new(),
            dropped: 0,
        };
    }

    let mut dropped: u32 = 0;

    let step1 = BEARER_PATTERN.replace_all(input, |_: &Captures| {
        dropped += 1;
        format!("Bearer {REDACTED}")
    });
    let step2 = HOME_PATH_PATTERN.replace_all(&step1, |caps: &Captures| {
        dropped += 1;
        format!("{}{REDACTED}", &caps[1])
    });
    let mut value = step2.into_owned();

    let mut should_drop = false;
    for pattern in DROP_MATCHERS.iter() {
        let hits = pattern.find_iter(&value).count();
        if hits > 0 {
            dropped += hits as u32;
            should_drop = true;
        }
    }
    if should_drop {
        return Redaction {
            value: String::new(),
            dropped,
        };
    }

    let before = count_markers(&value);
    let piied = redact_pii(&value);
    if piied != value {
        dropped += count_markers(&piied).saturating_sub(before);
        value = piied;
    }

    Redaction { value, dropped }
}

/// Residual-PII pass mirroring the TS `redactText`: cards (Luhn-gated), email, SSN, IPv4, phone, and
/// sensitive JSON values. Bearer/home are already handled by `redact_field`, so they are not repeated.
fn redact_pii(text: &str) -> String {
    let mut out = redact_credit_cards(text);
    out = EMAIL.replace_all(&out, REDACTED).into_owned();
    out = SSN.replace_all(&out, REDACTED).into_owned();
    out = IPV4.replace_all(&out, REDACTED).into_owned();
    out = PHONE.replace_all(&out, "${1}[REDACTED]").into_owned();
    out = SENSITIVE_JSON_VALUE
        .replace_all(&out, "${1}[REDACTED]${3}")
        .into_owned();
    out
}

/// Masks only digit runs that pass a Luhn check, so long non-card numbers (timestamps, ids) survive.
fn redact_credit_cards(text: &str) -> String {
    CARD_CANDIDATE
        .replace_all(text, |caps: &Captures| {
            let slice = &caps[0];
            let digits: String = slice.chars().filter(char::is_ascii_digit).collect();
            if (13..=19).contains(&digits.len()) && luhn_valid(&digits) {
                REDACTED.to_string()
            } else {
                slice.to_string()
            }
        })
        .into_owned()
}

/// Luhn checksum over a digit-only string.
fn luhn_valid(digits: &str) -> bool {
    if !(13..=19).contains(&digits.len()) {
        return false;
    }
    let mut sum = 0u32;
    let mut alt = false;
    for ch in digits.bytes().rev() {
        if !ch.is_ascii_digit() {
            return false;
        }
        let mut n = u32::from(ch - b'0');
        if alt {
            n *= 2;
            if n > 9 {
                n -= 9;
            }
        }
        sum += n;
        alt = !alt;
    }
    sum.is_multiple_of(10)
}

/// Counts `[REDACTED]` markers so the PII pass can report how many items it masked.
fn count_markers(text: &str) -> u32 {
    text.matches(REDACTED).count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_is_untouched_with_zero_drops() {
        assert_eq!(
            redact_field("git status --short"),
            Redaction {
                value: "git status --short".to_string(),
                dropped: 0
            }
        );
    }

    #[test]
    fn empty_input_passes_through() {
        assert_eq!(
            redact_field(""),
            Redaction {
                value: String::new(),
                dropped: 0
            }
        );
    }

    #[test]
    fn drops_the_whole_field_on_a_credential() {
        let r = redact_field("export OPENAI_API_KEY=sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
        assert_eq!(r.value, "");
        assert!(r.dropped >= 1);
    }

    #[test]
    fn masks_a_bearer_header_without_dropping_it() {
        let r = redact_field("Authorization: Bearer sk-proj-aBcD1234EfGh5678IjKl9012MnOp");
        assert!(!r.value.is_empty());
        assert!(!r.value.contains("sk-proj"));
        assert_eq!(r.value, "Authorization: Bearer [REDACTED]");
        assert_eq!(r.dropped, 1);
    }

    #[test]
    fn masks_a_home_path_username_keeping_the_shape() {
        let r = redact_field("/Users/janedoe/.aws/credentials");
        assert_eq!(r.value, "/Users/[REDACTED]/.aws/credentials");
        assert_eq!(r.dropped, 1);
    }

    #[test]
    fn masks_email_but_keeps_the_surrounding_text() {
        let r = redact_field("contact jane.doe@example.com for access");
        assert_eq!(r.value, "contact [REDACTED] for access");
        assert_eq!(r.dropped, 1);
    }

    #[test]
    fn masks_a_luhn_valid_card_but_keeps_an_invalid_run() {
        // 4111111111111111 is the canonical Luhn-valid Visa test number. The shared card pattern can
        // absorb a trailing separator, so assert the number is gone rather than exact whitespace.
        let masked = redact_field("pay 4111111111111111 now");
        assert!(!masked.value.contains("4111111111111111"));
        assert!(masked.value.contains(REDACTED));
        assert_eq!(masked.dropped, 1);
        // Flipping the last check digit breaks Luhn, so the run is left intact.
        let kept = redact_field("ref 4111111111111112 ok");
        assert_eq!(kept.value, "ref 4111111111111112 ok");
        assert_eq!(kept.dropped, 0);
    }
}
