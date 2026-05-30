// SPDX-License-Identifier: MIT
// Original Trace Flow code. otto extracted no pull-request links; this is the passive, local-evidence
// PR attribution input the ADR ("Repo and pull request attribution") calls for. Trace Flow owns the
// contract, IDs, pricing, redaction, and storage around this code.

//! `AgentPullRequestLinkFact` emission for Claude Code and Codex CLI transcripts.
//! [`claude_pr_link_facts`] and [`codex_pr_link_facts`] scan a session for **canonical GitHub
//! pull-request links** — `github.com/{owner}/{repo}/pull/{number}` — and emit one fact per distinct
//! observed link. These links are the only v1 PR-attribution signal: an agent usually emits a click
//! target, and that target carries both repo identity and PR number (ADR "Repo and pull request
//! attribution").
//!
//! **Only links, never commands.** `gh pr create`, `gh pr view`, `git push`, branch names, and bare PR
//! numbers are diagnostic evidence for *future* enrichment, not attribution, so this emitter reads
//! assistant message text, tool *output*, and user/transcript text — never tool *input* / command
//! strings. Every canonical link is `confidence = High` in v1; the `Medium`/`Low` rungs and non-GitHub
//! hosts are reserved for that deferred diagnostic enrichment.
//!
//! **Identity / dedup mirrors the ingest Worker pk.** The Worker keys `pull_request_link_pk` on
//! `(source, vendor_session_id, source_event_id ?? turn:<stable_turn_index>, url)`. To never emit two
//! rows that would collide, observations are deduped on `(source_event_id, url)` in document order, and
//! `stable_turn_index` is a per-session ordinal over the surviving distinct links. Claude records carry
//! a stable per-record `uuid`, so `source_event_id` is set and the *same* link in two different records
//! is two genuine observations; Codex records carry no per-record id, so `source_event_id` is `None`
//! and a link repeated across the session collapses to one row. That asymmetry is inherited directly
//! from the pk formula, not invented here. The ordinal is stable across a re-parse of the same session.

use std::collections::HashSet;
use std::sync::LazyLock;

use collector_contracts::enums::{PullRequestLinkConfidence, PullRequestLinkEvidence};
use collector_contracts::facts::AgentPullRequestLinkFact;
use regex::Regex;
use serde_json::Value;

use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// Canonical GitHub pull-request link: `github.com/{owner}/{repo}/pull/{number}` (ADR v1 GitHub-only).
/// `/pull/` is singular and a numeric id is required, so issue links, the `/pulls` list page, and bare
/// PR numbers never match. Owner is a GitHub login (alphanumerics joined by single hyphens); repo
/// additionally allows `.` and `_`, and must start/end alphanumeric. The scheme is ignored — a bare
/// `github.com/...` reference counts the same as a full URL. Host look-alikes (`evilgithub.com`,
/// `my-github.com`) and subdomains (`api.github.com`) are rejected by [`parse_pr_links`], not here: the
/// `regex` crate has no look-behind, so the preceding character is checked after the match.
static PR_URL_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/([A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/pull/(\d+)",
    )
    .expect("pr url pattern")
});

/// A parsed canonical GitHub pull-request link, normalized to its `https://` form. Only public repo
/// coordinates (host/owner/repo/number) are kept — the surrounding text is never carried onto a fact.
struct PrLink {
    host: String,
    owner: String,
    repo: String,
    number: i64,
    url: String,
}

/// Every canonical GitHub PR link in `text`, in first-appearance order (duplicates are collapsed later,
/// at session scope). A `number` that overflows `i64` is not a real PR and is skipped.
fn parse_pr_links(text: &str) -> Vec<PrLink> {
    let bytes = text.as_bytes();
    PR_URL_PATTERN
        .captures_iter(text)
        .filter_map(|caps| {
            let matched = caps.get(0)?;
            // No look-behind in the `regex` crate, so guard the host boundary here: a host-continuation
            // char immediately before `github.com` means this is a different domain — a subdomain
            // (`api.github.com`) or a look-alike (`evilgithub.com`, `my-github.com`) — not GitHub. Those
            // delimiters are ASCII, so indexing the preceding byte stays on a char boundary.
            if let Some(prev) = matched.start().checked_sub(1) {
                if matches!(bytes[prev], b'.' | b'-' | b'_' | b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9') {
                    return None;
                }
            }
            // `\d+` stops at the first non-digit, so `pull/270abc` would otherwise canonicalize to PR
            // 270. A word-continuation char right after the number means the digits were truncated from
            // a larger token, not a real PR id; a real link ends in `/`, `#`, `?`, `)`, whitespace, or EOL.
            if let Some(&next) = bytes.get(matched.end()) {
                if matches!(next, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-') {
                    return None;
                }
            }
            // GitHub owners and repos are case-insensitive; canonicalize to lowercase so differently
            // cased references dedupe to one link (and one Worker pk) rather than fragmenting attribution.
            let owner = caps.get(1)?.as_str().to_lowercase();
            let repo = caps.get(2)?.as_str().to_lowercase();
            let number = caps.get(3)?.as_str().parse::<i64>().ok()?;
            let url = format!("https://github.com/{owner}/{repo}/pull/{number}");
            Some(PrLink {
                host: "github.com".to_string(),
                owner,
                repo,
                number,
                url,
            })
        })
        .collect()
}

/// The record's `event_at` in epoch ms from its top-level RFC3339 `timestamp`, falling back to the
/// session start when a record omits or malforms it. Duplicated from the sibling emitters deliberately —
/// hoisting it would edit those committed files, outside this task's lane. Future cleanup.
fn record_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

/// Accumulates distinct PR-link observations across a session, deduping on `(source_event_id, url)` to
/// mirror the ingest Worker pk and stamping each survivor with the next per-session ordinal.
struct LinkAccumulator {
    facts: Vec<AgentPullRequestLinkFact>,
    seen: HashSet<(Option<String>, String)>,
    ordinal: i64,
}

impl LinkAccumulator {
    fn new() -> Self {
        Self {
            facts: Vec::new(),
            seen: HashSet::new(),
            ordinal: 0,
        }
    }

    /// Parses `text`, emitting one fact per not-yet-seen `(source_event_id, url)`. First observation of
    /// a link wins, so its evidence/timestamp are the stored ones (document order is deterministic).
    fn scan(
        &mut self,
        text: &str,
        source_event_id: Option<&str>,
        event_at: i64,
        evidence: PullRequestLinkEvidence,
        ctx: &SessionContext,
    ) {
        for link in parse_pr_links(text) {
            let key = (source_event_id.map(str::to_string), link.url.clone());
            if !self.seen.insert(key) {
                continue;
            }
            self.facts.push(AgentPullRequestLinkFact {
                vendor_session_id: ctx.vendor_session_id.clone(),
                source_event_id: source_event_id.map(str::to_string),
                stable_turn_index: self.ordinal,
                event_at,
                host: link.host,
                owner: link.owner,
                repo: link.repo,
                number: link.number,
                url: link.url,
                // v1: every canonical link is high-confidence; diagnostic rungs are deferred enrichment.
                confidence: PullRequestLinkConfidence::High,
                evidence,
                // Only the public canonical URL is stored, so nothing is redacted away.
                dropped_sensitive: 0,
            });
            self.ordinal += 1;
        }
    }
}

/// The `text` of a content block (`{ "type": "...", "text": "..." }`), or `None` for a block with no
/// string `text` (a `tool_use`, `thinking`, image, …).
fn block_text(block: &Value) -> Option<&str> {
    block.get("text").and_then(Value::as_str)
}

/// The text bodies inside a Claude `tool_result` block: the `content` is a plain string, or an array of
/// `{ type: "text", text }` blocks (Claude's two output shapes). This is the agent-produced output of a
/// tool — `gh pr create`'s printed PR URL lands here — not the command that was run.
fn tool_result_texts(block: &Value) -> Vec<&str> {
    match block.get("content") {
        Some(Value::String(text)) => vec![text.as_str()],
        Some(Value::Array(parts)) => parts.iter().filter_map(block_text).collect(),
        _ => Vec::new(),
    }
}

/// Emits one [`AgentPullRequestLinkFact`] per distinct canonical GitHub PR link observed in a Claude
/// session: assistant message text ([`PullRequestLinkEvidence::AssistantText`]), `tool_result` output
/// ([`PullRequestLinkEvidence::ToolOutput`]), and user message text
/// ([`PullRequestLinkEvidence::TranscriptRecord`]). `source_event_id` is each record's `uuid`.
pub fn claude_pr_link_facts(
    records: &[Value],
    ctx: &SessionContext,
) -> Vec<AgentPullRequestLinkFact> {
    let mut acc = LinkAccumulator::new();
    for record in records {
        let event_at = record_event_at(record, ctx);
        let source_event_id = record.get("uuid").and_then(Value::as_str);
        let content = record.get("message").and_then(|m| m.get("content"));
        match record.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                if let Some(Value::Array(blocks)) = content {
                    for text in blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(block_text)
                    {
                        acc.scan(
                            text,
                            source_event_id,
                            event_at,
                            PullRequestLinkEvidence::AssistantText,
                            ctx,
                        );
                    }
                }
            }
            Some("user") => match content {
                // A plain-string user turn is the user's own prose: transcript evidence, not a tool.
                Some(Value::String(text)) => acc.scan(
                    text,
                    source_event_id,
                    event_at,
                    PullRequestLinkEvidence::TranscriptRecord,
                    ctx,
                ),
                Some(Value::Array(blocks)) => {
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("tool_result") => {
                                for text in tool_result_texts(block) {
                                    acc.scan(
                                        text,
                                        source_event_id,
                                        event_at,
                                        PullRequestLinkEvidence::ToolOutput,
                                        ctx,
                                    );
                                }
                            }
                            Some("text") => {
                                if let Some(text) = block_text(block) {
                                    acc.scan(
                                        text,
                                        source_event_id,
                                        event_at,
                                        PullRequestLinkEvidence::TranscriptRecord,
                                        ctx,
                                    );
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    acc.facts
}

/// The text bodies of a Codex `message` payload: `content` is a plain string, or an array of
/// `{ type, text }` blocks (`input_text` for user, `output_text` for assistant).
fn codex_message_texts(payload: &Value) -> Vec<&str> {
    match payload.get("content") {
        Some(Value::String(text)) => vec![text.as_str()],
        Some(Value::Array(blocks)) => blocks.iter().filter_map(block_text).collect(),
        _ => Vec::new(),
    }
}

/// The text body of a Codex `function_call_output` payload: a plain string, or `{ output, metadata }`
/// (the wrapped shape some builds write). This is the tool's output, not its `arguments`. Mirrors
/// `emit_codex_tools::output_text`, but takes the `payload` (not the whole record) since this walker
/// already has it in hand — a difference to reconcile in the future shared-helper cleanup.
fn codex_output_text(payload: &Value) -> Option<&str> {
    match payload.get("output")? {
        Value::String(text) => Some(text),
        output @ Value::Object(_) => output.get("output").and_then(Value::as_str),
        _ => None,
    }
}

/// Emits one [`AgentPullRequestLinkFact`] per distinct canonical GitHub PR link observed in a Codex
/// session: assistant message text ([`PullRequestLinkEvidence::AssistantText`]),
/// `function_call_output` text ([`PullRequestLinkEvidence::ToolOutput`]), and user message text
/// ([`PullRequestLinkEvidence::TranscriptRecord`]). Codex carries no per-record id, so `source_event_id`
/// is `None` and the same link repeated across the session collapses to one row (see module docs).
pub fn codex_pr_link_facts(
    records: &[Value],
    ctx: &SessionContext,
) -> Vec<AgentPullRequestLinkFact> {
    let mut acc = LinkAccumulator::new();
    for record in records {
        if record.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let Some(payload) = record.get("payload") else {
            continue;
        };
        let event_at = record_event_at(record, ctx);
        match payload.get("type").and_then(Value::as_str) {
            Some("message") => {
                let evidence = match payload.get("role").and_then(Value::as_str) {
                    Some("assistant") => PullRequestLinkEvidence::AssistantText,
                    _ => PullRequestLinkEvidence::TranscriptRecord,
                };
                for text in codex_message_texts(payload) {
                    acc.scan(text, None, event_at, evidence, ctx);
                }
            }
            Some("function_call_output") => {
                if let Some(text) = codex_output_text(payload) {
                    acc.scan(
                        text,
                        None,
                        event_at,
                        PullRequestLinkEvidence::ToolOutput,
                        ctx,
                    );
                }
            }
            _ => {}
        }
    }
    acc.facts
}

/// Emits one [`AgentPullRequestLinkFact`] per distinct canonical GitHub PR link observed in a Cursor
/// session: assistant bubble text ([`PullRequestLinkEvidence::AssistantText`]), tool result output
/// ([`PullRequestLinkEvidence::ToolOutput`]), and user bubble text
/// ([`PullRequestLinkEvidence::TranscriptRecord`]). Cursor bubbles carry a stable `bubbleId`, so
/// `source_event_id` is set and the *same* link in two bubbles is two genuine observations — the
/// Claude-like semantics, not the Codex collapse (see module docs). The reader's normalized records carry
/// `__composer_id`/`__model`; this reads only the bubble's own `type`/`text`/`toolFormerData.result`.
pub fn cursor_pr_link_facts(
    records: &[Value],
    ctx: &SessionContext,
) -> Vec<AgentPullRequestLinkFact> {
    use crate::cursor_records::{
        bubble_id, bubble_text, bubble_type, tool_block, BUBBLE_TYPE_ASSISTANT, BUBBLE_TYPE_USER,
    };

    let mut acc = LinkAccumulator::new();
    for record in records {
        let event_at = record
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(rfc3339_to_epoch_ms)
            .or(ctx.vendor_started_at)
            .unwrap_or(0);
        let source_event_id = bubble_id(record);

        if let Some(text) = bubble_text(record) {
            // A link the agent printed in its reply is assistant evidence; one in the user's prose is
            // transcript evidence. An unknown bubble type is treated as transcript, the conservative rung.
            let evidence = match bubble_type(record) {
                Some(BUBBLE_TYPE_ASSISTANT) => PullRequestLinkEvidence::AssistantText,
                Some(BUBBLE_TYPE_USER) => PullRequestLinkEvidence::TranscriptRecord,
                _ => PullRequestLinkEvidence::TranscriptRecord,
            };
            acc.scan(text, source_event_id, event_at, evidence, ctx);
        }

        // A PR url the tool printed (e.g. `gh pr create`'s output) is tool-output evidence — never the
        // tool's command/arguments, which are diagnostic-only and not scanned.
        if let Some(result) = tool_block(record).and_then(|b| b.result) {
            acc.scan(
                result,
                source_event_id,
                event_at,
                PullRequestLinkEvidence::ToolOutput,
                ctx,
            );
        }
    }
    acc.facts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PR: &str = "https://github.com/zaks-io/trace-flow/pull/270";

    fn ctx() -> SessionContext {
        SessionContext {
            vendor_session_id: "sess-1".to_string(),
            agent_id: "agent-abc".to_string(),
            normalized_git_remote: "github.com/zaks-io/trace-flow".to_string(),
            repo_path_fallback: "trace-flow".to_string(),
            git_branch: "main".to_string(),
            git_head_sha: "deadbeef".to_string(),
            vendor_started_at: Some(1_778_964_000_000),
            agent_depth: 0,
            repo_root: String::new(),
        }
    }

    fn claude_assistant(uuid: &str, text: &str, ts: &str) -> Value {
        json!({
            "type": "assistant", "uuid": uuid, "timestamp": ts,
            "message": { "id": "msg_1", "content": [{ "type": "text", "text": text }] }
        })
    }

    fn claude_user_text(uuid: &str, text: &str, ts: &str) -> Value {
        json!({
            "type": "user", "uuid": uuid, "timestamp": ts,
            "message": { "role": "user", "content": text }
        })
    }

    fn claude_tool_result(uuid: &str, content: Value, ts: &str) -> Value {
        json!({
            "type": "user", "uuid": uuid, "timestamp": ts,
            "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": content }] }
        })
    }

    fn codex_message(role: &str, text: &str, ts: &str) -> Value {
        json!({
            "type": "response_item", "timestamp": ts,
            "payload": { "type": "message", "role": role, "content": [{ "type": "output_text", "text": text }] }
        })
    }

    fn codex_output(text: &str, ts: &str) -> Value {
        json!({
            "type": "response_item", "timestamp": ts,
            "payload": { "type": "function_call_output", "call_id": "c1", "output": text }
        })
    }

    #[test]
    fn claude_assistant_text_yields_one_high_confidence_link() {
        let records = [claude_assistant(
            "u1",
            &format!("Opened {PR} for review"),
            "2026-05-27T12:00:00Z",
        )];
        let facts = claude_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        let f = &facts[0];
        assert_eq!(f.host, "github.com");
        assert_eq!(f.owner, "zaks-io");
        assert_eq!(f.repo, "trace-flow");
        assert_eq!(f.number, 270);
        assert_eq!(f.url, PR);
        assert_eq!(f.confidence, PullRequestLinkConfidence::High);
        assert_eq!(f.evidence, PullRequestLinkEvidence::AssistantText);
        assert_eq!(f.source_event_id.as_deref(), Some("u1"));
        assert_eq!(f.stable_turn_index, 0);
        assert_eq!(f.dropped_sensitive, 0);
        assert_eq!(
            f.event_at,
            rfc3339_to_epoch_ms("2026-05-27T12:00:00Z").unwrap()
        );
    }

    #[test]
    fn claude_tool_result_string_and_array_are_tool_output_evidence() {
        let string_result =
            claude_tool_result("u1", json!(format!("created {PR}")), "2026-05-27T12:00:00Z");
        let array_result = claude_tool_result(
            "u2",
            json!([{ "type": "text", "text": format!("see {PR}") }]),
            "2026-05-27T12:00:01Z",
        );
        for record in [string_result, array_result] {
            let facts = claude_pr_link_facts(&[record], &ctx());
            assert_eq!(facts.len(), 1);
            assert_eq!(facts[0].evidence, PullRequestLinkEvidence::ToolOutput);
            assert_eq!(facts[0].url, PR);
        }
    }

    #[test]
    fn claude_user_prose_is_transcript_record_evidence() {
        let records = [claude_user_text(
            "u1",
            &format!("please land {PR}"),
            "2026-05-27T12:00:00Z",
        )];
        let facts = claude_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].evidence, PullRequestLinkEvidence::TranscriptRecord);
    }

    #[test]
    fn codex_assistant_message_and_tool_output_are_distinguished() {
        let records = [
            codex_message(
                "assistant",
                &format!("PR is {PR}"),
                "2026-05-16T20:53:00.000Z",
            ),
            codex_output(
                "https://github.com/zaks-io/agent-paste/pull/105",
                "2026-05-16T20:53:05.000Z",
            ),
        ];
        let facts = codex_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].evidence, PullRequestLinkEvidence::AssistantText);
        assert_eq!(facts[0].number, 270);
        assert_eq!(facts[1].evidence, PullRequestLinkEvidence::ToolOutput);
        assert_eq!(facts[1].repo, "agent-paste");
        assert_eq!(facts[1].number, 105);
        // Codex carries no per-record id.
        assert!(facts.iter().all(|f| f.source_event_id.is_none()));
    }

    #[test]
    fn codex_user_message_is_transcript_record_evidence() {
        let records = [codex_message(
            "user",
            &format!("review {PR}"),
            "2026-05-16T20:53:00.000Z",
        )];
        let facts = codex_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].evidence, PullRequestLinkEvidence::TranscriptRecord);
    }

    #[test]
    fn codex_dedupes_a_repeated_link_to_one_row() {
        // Same PR mentioned in three records; Codex has no per-record id, so they collapse to one fact.
        let records = [
            codex_message(
                "assistant",
                &format!("opening {PR}"),
                "2026-05-16T20:53:00.000Z",
            ),
            codex_output(&format!("created {PR}"), "2026-05-16T20:53:05.000Z"),
            codex_message(
                "assistant",
                &format!("done: {PR}"),
                "2026-05-16T20:54:00.000Z",
            ),
        ];
        let facts = codex_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].stable_turn_index, 0);
        // First observation wins: the assistant text seen first, at the first timestamp.
        assert_eq!(facts[0].evidence, PullRequestLinkEvidence::AssistantText);
    }

    #[test]
    fn claude_same_link_in_two_records_is_two_observations() {
        // Claude records carry distinct uuids, so the pk keeps them apart — two genuine observations.
        let records = [
            claude_assistant("u1", &format!("opened {PR}"), "2026-05-27T12:00:00Z"),
            claude_assistant("u2", &format!("merged {PR}"), "2026-05-27T12:05:00Z"),
        ];
        let facts = claude_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].stable_turn_index, 0);
        assert_eq!(facts[1].stable_turn_index, 1);
        assert_ne!(facts[0].source_event_id, facts[1].source_event_id);
    }

    #[test]
    fn the_same_link_repeated_within_one_record_collapses() {
        let records = [claude_assistant(
            "u1",
            &format!("{PR} and again {PR}"),
            "2026-05-27T12:00:00Z",
        )];
        assert_eq!(claude_pr_link_facts(&records, &ctx()).len(), 1);
    }

    #[test]
    fn distinct_links_in_one_text_each_emit_in_order() {
        let text = format!("first {PR} then https://github.com/zaks-io/trace-flow/pull/271");
        let records = [claude_assistant("u1", &text, "2026-05-27T12:00:00Z")];
        let facts = claude_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].number, 270);
        assert_eq!(facts[1].number, 271);
        assert_eq!(facts[1].stable_turn_index, 1);
    }

    #[test]
    fn trailing_path_query_and_punctuation_are_stripped_to_canonical_url() {
        let cases = [
            "https://github.com/zaks-io/trace-flow/pull/270/files",
            "https://github.com/zaks-io/trace-flow/pull/270#issuecomment-1",
            "(https://github.com/zaks-io/trace-flow/pull/270)",
            "see github.com/zaks-io/trace-flow/pull/270.",
            "http://github.com/zaks-io/trace-flow/pull/270",
            "HTTPS://GitHub.com/zaks-io/trace-flow/pull/270",
        ];
        for case in cases {
            let records = [claude_assistant("u1", case, "2026-05-27T12:00:00Z")];
            let facts = claude_pr_link_facts(&records, &ctx());
            assert_eq!(facts.len(), 1, "case: {case}");
            assert_eq!(facts[0].url, PR, "case: {case}");
            assert_eq!(facts[0].number, 270, "case: {case}");
        }
    }

    #[test]
    fn non_canonical_references_are_not_links() {
        let cases = [
            "the issue github.com/zaks-io/trace-flow/issues/270",
            "the list github.com/zaks-io/trace-flow/pulls",
            "just merged PR #270",
            "ran gh pr create --fill",
            "github.com/zaks-io/trace-flow/pull/notanumber",
            // `\d+` stops at the first letter, so a number glued to a suffix is a truncated token, not PR 270.
            "github.com/zaks-io/trace-flow/pull/270abc",
            // Host look-alikes and subdomains are not github.com.
            "pushed to evilgithub.com/zaks-io/trace-flow/pull/270",
            "the mirror my-github.com/zaks-io/trace-flow/pull/270",
            "via api.github.com/zaks-io/trace-flow/pull/270",
            "an enterprise github.com.evil.example/zaks-io/trace-flow/pull/270",
        ];
        for case in cases {
            let records = [claude_assistant("u1", case, "2026-05-27T12:00:00Z")];
            assert!(
                claude_pr_link_facts(&records, &ctx()).is_empty(),
                "case: {case}"
            );
        }
    }

    #[test]
    fn owner_and_repo_are_canonicalized_to_lowercase_so_casing_dedupes() {
        // GitHub owner/repo are case-insensitive. A mixed-case reference must produce the same canonical
        // url (and Worker pk) as the lowercase one, or one repo's links fragment across rows and the
        // session never reaches the "exactly one canonical link" attribution bar.
        let records = [claude_assistant(
            "u1",
            "see https://github.com/Zaks-IO/Trace-Flow/pull/270",
            "2026-05-27T12:00:00Z",
        )];
        let facts = claude_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].owner, "zaks-io");
        assert_eq!(facts[0].repo, "trace-flow");
        assert_eq!(facts[0].url, PR);
    }

    #[test]
    fn command_input_is_not_scanned_for_links() {
        // The URL rides a `gh pr view` tool_use *input* (a command string), which is diagnostic-only and
        // must not produce a link fact. Only assistant text, tool output, and user text are scanned.
        let records = [json!({
            "type": "assistant", "uuid": "u1", "timestamp": "2026-05-27T12:00:00Z",
            "message": { "id": "msg_1", "content": [
                { "type": "tool_use", "id": "t1", "name": "Bash",
                  "input": { "command": format!("gh pr view {PR}") } }
            ] }
        })];
        assert!(claude_pr_link_facts(&records, &ctx()).is_empty());
    }

    #[test]
    fn codex_function_call_arguments_are_not_scanned_for_links() {
        // The Codex twin of the Claude case: a `function_call` carries the URL in its `arguments`
        // command string (diagnostic-only). Only `message` and `function_call_output` are scanned.
        let records = [json!({
            "type": "response_item", "timestamp": "2026-05-16T20:53:00.000Z",
            "payload": { "type": "function_call", "name": "exec_command", "call_id": "c1",
                "arguments": format!("{{\"cmd\":\"gh pr view {PR}\"}}") }
        })];
        assert!(codex_pr_link_facts(&records, &ctx()).is_empty());
    }

    #[test]
    fn reparse_is_idempotent() {
        let records = [
            claude_assistant("u1", &format!("opened {PR}"), "2026-05-27T12:00:00Z"),
            claude_assistant(
                "u2",
                "see https://github.com/a/b/pull/9",
                "2026-05-27T12:01:00Z",
            ),
        ];
        assert_eq!(
            claude_pr_link_facts(&records, &ctx()),
            claude_pr_link_facts(&records, &ctx())
        );
    }

    #[test]
    fn event_at_falls_back_to_session_start_when_timestamp_missing() {
        let records = [json!({
            "type": "assistant", "uuid": "u1",
            "message": { "id": "msg_1", "content": [{ "type": "text", "text": PR }] }
        })];
        let facts = claude_pr_link_facts(&records, &ctx());
        assert_eq!(facts[0].event_at, 1_778_964_000_000);
    }

    #[test]
    fn empty_sessions_emit_no_facts() {
        assert!(claude_pr_link_facts(&[], &ctx()).is_empty());
        assert!(codex_pr_link_facts(&[], &ctx()).is_empty());
        assert!(cursor_pr_link_facts(&[], &ctx()).is_empty());
    }

    fn cursor_bubble(bubble_id: &str, bubble_type: i64, text: &str) -> Value {
        json!({
            "__composer_id": "comp-1", "__model": "gpt-5.2",
            "type": bubble_type, "bubbleId": bubble_id, "text": text,
            "createdAt": "2026-05-25T23:37:23.355Z",
        })
    }

    #[test]
    fn cursor_assistant_bubble_text_is_assistant_evidence_keyed_on_bubble_id() {
        let records = [cursor_bubble("b1", 2, &format!("opened {PR}"))];
        let facts = cursor_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].evidence, PullRequestLinkEvidence::AssistantText);
        assert_eq!(facts[0].number, 270);
        assert_eq!(facts[0].source_event_id.as_deref(), Some("b1"));
    }

    #[test]
    fn cursor_tool_result_output_is_tool_output_evidence() {
        let params = serde_json::to_string(&json!({ "command": "gh pr create" })).unwrap();
        let records = [json!({
            "__composer_id": "comp-1", "__model": "gpt-5.2", "type": 2, "bubbleId": "b1",
            "createdAt": "2026-05-25T23:37:23.355Z",
            "toolFormerData": { "name": "run_terminal_command_v2", "status": "completed",
                "params": params, "result": format!("created {PR}") },
        })];
        let facts = cursor_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].evidence, PullRequestLinkEvidence::ToolOutput);
        assert_eq!(facts[0].url, PR);
    }

    #[test]
    fn cursor_same_link_in_two_bubbles_is_two_observations() {
        // Cursor bubbles carry distinct ids, so (like Claude) the pk keeps repeated links apart.
        let records = [
            cursor_bubble("b1", 2, &format!("opened {PR}")),
            cursor_bubble("b2", 2, &format!("merged {PR}")),
        ];
        let facts = cursor_pr_link_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_ne!(facts[0].source_event_id, facts[1].source_event_id);
        assert_eq!(facts[1].stable_turn_index, 1);
    }
}
