import { redactText } from '@trace-flow/utils';

/**
 * Server-side re-redaction backstop. The Rust Collector parser (3a) is the primary redactor; this
 * is defense in depth at the trust boundary — the Worker never trusts that the client redacted, so
 * it re-runs the shared canary corpus (`fixtures/redaction-canary.json`) over every free-text field.
 *
 * Two outcomes, matching the canary's `expect`:
 *  - **mask**: the secret is replaced in place, surrounding structure kept (Bearer header, home dir).
 *  - **drop**: a high-confidence credential pattern matched, so the WHOLE field is withheld (`''`).
 *
 * Pass order is load-bearing:
 *  1. Structure-preserving masks (Bearer header, home dir) run first. An `Authorization: Bearer
 *     sk-...` token would otherwise trip the `sk-` drop matcher and discard a field the canary says
 *     to keep; masking the Bearer value first neutralizes the token so the drop pass sees nothing.
 *  2. Drop matchers run next, on the still-raw credential text. The general PII pass (step 3) would
 *     mangle a slack token's digit groups or a dotenv URL's `user@host` into `[REDACTED]`, breaking
 *     the high-confidence credential shape so the drop matcher could no longer recognize it.
 *  3. Residual PII (cards, email, SSN, IP, phone) is masked last, only on a field we are keeping.
 */

const REDACTED = '[REDACTED]';

export const MAX_COMMAND_EXCERPT = 1024;
export const MAX_ERROR_EXCERPT = 4096;

/** Mask matchers keep the field; each replaces its capture and counts one toward `dropped`. */
const HOME_PATH_PATTERN = /(\/(?:Users|home)\/)([^/\s]+)/g;

// `Authorization: Bearer <token>` — masked in place so the token can't trip a drop matcher.
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*(?=\s|$|[^A-Za-z0-9\-._~+/=])/gi;

/**
 * Drop matchers withhold the entire field on any match (a credential surviving anywhere in the
 * string means the field is untrustworthy). High-confidence, low-false-positive patterns only.
 */
const DROP_MATCHERS: RegExp[] = [
  // AWS access key id (AKIA/ASIA + 16 base32 chars).
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // AWS secret access key assignment (40-char base64-ish value).
  /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+]{40}/gi,
  // GitHub fine-grained PAT (before the classic matcher; distinct prefix, may contain `_`).
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // GitHub classic PAT / OAuth / refresh / server tokens.
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  // OpenAI-style API key (`sk-` + ≥ 20 chars). Bearer masking runs first so headers are kept.
  /\bsk-[A-Za-z0-9-]{20,}\b/g,
  // Slack tokens (bot/user/app/refresh/legacy).
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Credentials embedded in a URL userinfo (`scheme://user:password@host`).
  /:\/\/[^:/?#@\s]+:[^@/?#\s]+@/g,
  // JWT (three base64url segments).
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // PEM private key header (RSA/EC/OPENSSH/PKCS8).
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
  // `$HOME`-rooted path (home dir + the file it points at must not survive).
  /\$HOME(?:\/\S+)?/g,
];

export interface RedactionResult {
  value: string;
  /** How many sensitive matches were dropped or masked; feeds the fact's `dropped_sensitive`. */
  dropped: number;
}

/**
 * Masks or drops sensitive substrings in a single free-text field. Returns the cleaned value (`''`
 * if any drop matcher fired) and a count of sensitive hits to fold into `dropped_sensitive`.
 */
export function redactField(input: string): RedactionResult {
  if (!input) return { value: input, dropped: 0 };

  let value = input;
  let dropped = 0;

  // 1. Structure-preserving masks — Bearer header value, then home directory (keep the path shape).
  value = value.replace(BEARER_PATTERN, () => {
    dropped += 1;
    return `Bearer ${REDACTED}`;
  });
  value = value.replace(HOME_PATH_PATTERN, (_m, prefix: string) => {
    dropped += 1;
    return `${prefix}${REDACTED}`;
  });

  // 2. Drop pass — any credential match withholds the whole field (runs before the PII mask so the
  //    credential shape is still intact).
  let shouldDrop = false;
  for (const pattern of DROP_MATCHERS) {
    const matches = value.match(pattern);
    if (matches) {
      dropped += matches.length;
      shouldDrop = true;
    }
  }
  if (shouldDrop) return { value: '', dropped };

  // 3. Residual PII mask (cards, email, SSN, IP, phone) on the kept field. Each redactText hit adds
  //    one `[REDACTED]` marker, so the count of newly-introduced markers is the number of PII items.
  const piiRedacted = redactText(value);
  if (piiRedacted !== value) {
    dropped += countMarkers(piiRedacted) - countMarkers(value);
    value = piiRedacted;
  }
  return { value, dropped };
}

/** Counts `[REDACTED]` markers so a PII pass can report how many items it masked. */
function countMarkers(text: string): number {
  return text.split(REDACTED).length - 1;
}

/** Truncates a (already redacted) excerpt to its column cap, by code point so a surrogate pair is
 *  never split into a lone surrogate (which would serialize as a replacement char). */
export function capExcerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return [...text].slice(0, max).join('');
}
