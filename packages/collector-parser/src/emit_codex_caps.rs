// SPDX-License-Identifier: MIT
// Original Trace Flow code. otto had useful Codex capability hints (`base_instructions`, `dynamic_tools`)
// but no normalized upload contract, no Tinybird table, and no coverage semantics (ADR "Capability
// Snapshots"). Trace Flow defines that contract here: passive, conversation-only capture of
// privacy-safe counts, size/token estimates, and a stable content hash — never the raw instruction
// text, tool schemas, or any config value. Trace Flow owns the contract, IDs, pricing, redaction, and
// storage around this code.

//! Codex CLI `AgentCapabilitySnapshotFact` emission. [`codex_capability_facts`] reads each
//! `session_meta` record's available-capability surface and emits one snapshot per distinct
//! observation: the `base_instructions` system prompt (one item) and the `dynamic_tools` catalog
//! (one item per tool). Each fact ships **counts, sizes, a rough token estimate, and a SHA-256 of the
//! observed surface** — the raw instruction text and tool schemas are hashed, never uploaded, so a
//! later Context Bloat analysis has historical coverage without the conversation leaking (ADR
//! "Capability Snapshots").
//!
//! **Identity (why an ordinal, not the vendor id).** Codex's `session_meta.payload.id` is just the
//! session UUID — it repeats verbatim on every resume and carries no per-snapshot identity, so
//! `source_snapshot_id` is `None`. The ingest Worker then keys `capability_snapshot_pk` on
//! `turn:<stable_turn_index>`, and that pk does **not** include `capability_kind`, so two kinds read
//! from one `session_meta` would collide. [`stable_turn_index`](AgentCapabilitySnapshotFact) is
//! therefore a per-session ordinal over **distinct** observations, assigned in document order. Resumed
//! sessions re-state the same surface many times; observations are deduped on
//! `(capability_kind, content_hash)` so an unchanged surface collapses to one row while a genuine
//! change (a new prompt, a tool added) takes the next ordinal and lands as its own row. The ordinal is
//! stable across a re-parse of the same session.

use std::collections::HashSet;
use std::fmt::Write as _;

use collector_contracts::enums::AgentCapabilityKind;
use collector_contracts::facts::AgentCapabilitySnapshotFact;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::session_context::SessionContext;
use crate::timestamp::rfc3339_to_epoch_ms;

/// The record's `event_at` in epoch ms from its top-level RFC3339 `timestamp`, falling back to the
/// session start when a record omits or malforms it (real Codex `session_meta` records always carry one).
fn record_event_at(record: &Value, ctx: &SessionContext) -> i64 {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(rfc3339_to_epoch_ms)
        .or(ctx.vendor_started_at)
        .unwrap_or(0)
}

/// `"sha256:"` + lowercase hex of the SHA-256 of `bytes`. The surface is hashed, never stored raw, so
/// the column is a stable change-detection fingerprint (idempotent dedup, not a security boundary).
fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity("sha256:".len() + digest.len() * 2);
    out.push_str("sha256:");
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Rough token estimate from a character count: ~4 chars/token, rounded up so any non-empty surface
/// estimates at least one token. Deliberately coarse — the ADR asks for an estimate, not a tokenizer.
fn estimate_tokens(char_count: usize) -> i64 {
    char_count.div_ceil(4) as i64
}

/// One capability observation, pre-identity: the typed measurements an [`AgentCapabilitySnapshotFact`]
/// carries before the session ordinal and context are stamped on.
struct CapabilityObservation {
    kind: AgentCapabilityKind,
    item_count: i64,
    total_size_bytes: i64,
    total_tokens_estimate: i64,
    content_hash: String,
    redacted_label: String,
}

/// The stable snake_case discriminant for `kind`, used only as a dedup-key prefix so two kinds that
/// happened to hash identically still stay distinct. Mirrors the serde `rename_all = "snake_case"`.
fn kind_str(kind: AgentCapabilityKind) -> &'static str {
    match kind {
        AgentCapabilityKind::BaseInstructions => "base_instructions",
        AgentCapabilityKind::DynamicTools => "dynamic_tools",
        AgentCapabilityKind::McpServers => "mcp_servers",
        AgentCapabilityKind::Other => "other",
    }
}

/// The base-instructions text from a `session_meta` payload, trimmed: current Codex nests it as
/// `base_instructions.text`, older builds wrote a bare string — both map to the same surface. Empty or
/// whitespace-only text is treated as absent (no observation). Trimming keeps the size/token/hash
/// surface to the actual instruction text, so incidental leading/trailing whitespace can't inflate the
/// estimates or fork an otherwise-identical surface into a second row across resumes.
fn base_instructions_text(payload: &Value) -> Option<&str> {
    let value = payload.get("base_instructions")?;
    let text = value.as_str().or_else(|| value.get("text")?.as_str())?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// The `base_instructions` observation: a single item sized and hashed on its raw text. The text is
/// hashed only — never carried onto the fact.
fn base_instructions_observation(payload: &Value) -> Option<CapabilityObservation> {
    let text = base_instructions_text(payload)?;
    Some(CapabilityObservation {
        kind: AgentCapabilityKind::BaseInstructions,
        item_count: 1,
        total_size_bytes: text.len() as i64,
        total_tokens_estimate: estimate_tokens(text.chars().count()),
        content_hash: content_hash(text.as_bytes()),
        redacted_label: "base instructions".to_string(),
    })
}

/// The `dynamic_tools` observation: one item per tool, sized and hashed over an **order-independent**
/// canonical form (each tool compact-serialized, then the set sorted), so re-ordered-but-identical
/// catalogs across resumes dedupe while an added or changed tool does not. The tool schemas and
/// descriptions are hashed only — never carried onto the fact. An absent or empty catalog yields no
/// observation.
fn dynamic_tools_observation(payload: &Value) -> Option<CapabilityObservation> {
    let tools = payload.get("dynamic_tools")?.as_array()?;
    if tools.is_empty() {
        return None;
    }
    let mut serialized: Vec<String> = tools.iter().map(Value::to_string).collect();
    serialized.sort();
    let canonical = serialized.join("\n");
    let item_count = tools.len() as i64;
    let plural = if item_count == 1 { "" } else { "s" };
    Some(CapabilityObservation {
        kind: AgentCapabilityKind::DynamicTools,
        item_count,
        total_size_bytes: canonical.len() as i64,
        total_tokens_estimate: estimate_tokens(canonical.chars().count()),
        content_hash: content_hash(canonical.as_bytes()),
        redacted_label: format!("{item_count} dynamic tool{plural}"),
    })
}

/// Every capability observation a single `session_meta` payload exposes, in stable kind order.
/// `mcp_servers` is intentionally absent: current Codex transcripts do not record an MCP-server
/// inventory in `session_meta`, and the ADR forbids inferring one from local config.
fn observations(payload: &Value) -> Vec<CapabilityObservation> {
    [
        base_instructions_observation(payload),
        dynamic_tools_observation(payload),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn fact(
    obs: CapabilityObservation,
    event_at: i64,
    stable_turn_index: i64,
    ctx: &SessionContext,
) -> AgentCapabilitySnapshotFact {
    AgentCapabilitySnapshotFact {
        vendor_session_id: ctx.vendor_session_id.clone(),
        // Codex assigns no per-snapshot id (`session_meta.payload.id` is just the session UUID), so
        // identity falls to the per-session ordinal in `stable_turn_index`.
        source_snapshot_id: None,
        stable_turn_index,
        event_at,
        capability_kind: obs.kind,
        item_count: obs.item_count,
        total_size_bytes: obs.total_size_bytes,
        total_tokens_estimate: obs.total_tokens_estimate,
        content_hash: obs.content_hash,
        redacted_label: obs.redacted_label,
        // Counts, sizes, and a hash only — no raw text is uploaded, so nothing is dropped.
        dropped_sensitive: 0,
    }
}

/// Emits one [`AgentCapabilitySnapshotFact`] per distinct capability observation across a Codex
/// session's `session_meta` records. Observations are deduped on `(capability_kind, content_hash)` in
/// document order, and `stable_turn_index` is the ordinal of each distinct observation (see the module
/// docs for why that, not the vendor id, carries identity).
pub fn codex_capability_facts(
    records: &[Value],
    ctx: &SessionContext,
) -> Vec<AgentCapabilitySnapshotFact> {
    let mut facts = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut ordinal: i64 = 0;
    for record in records {
        if record.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let Some(payload) = record.get("payload") else {
            continue;
        };
        let event_at = record_event_at(record, ctx);
        for obs in observations(payload) {
            let dedup_key = format!("{}:{}", kind_str(obs.kind), obs.content_hash);
            if seen.insert(dedup_key) {
                facts.push(fact(obs, event_at, ordinal, ctx));
                ordinal += 1;
            }
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> SessionContext {
        SessionContext {
            vendor_session_id: "codex-sess-1".to_string(),
            agent_id: "agent-abc".to_string(),
            normalized_git_remote: "github.com/acme/trace-flow".to_string(),
            repo_path_fallback: "trace-flow".to_string(),
            git_branch: "main".to_string(),
            git_head_sha: "deadbeef".to_string(),
            vendor_started_at: Some(1_778_964_000_000),
            agent_depth: 0,
            repo_root: String::new(),
        }
    }

    fn tool(name: &str) -> Value {
        json!({
            "name": name,
            "namespace": "codex_app",
            "description": format!("does {name}"),
            "inputSchema": { "type": "object", "properties": {} }
        })
    }

    fn session_meta(base: Value, tools: Value, ts: &str) -> Value {
        json!({
            "type": "session_meta",
            "timestamp": ts,
            "payload": {
                "id": "codex-sess-1",
                "base_instructions": base,
                "dynamic_tools": tools
            }
        })
    }

    #[test]
    fn emits_base_instructions_and_dynamic_tools_from_one_meta() {
        let records = [session_meta(
            json!({ "text": "You are Codex." }),
            json!([tool("a"), tool("b"), tool("c")]),
            "2026-05-16T20:53:00.000Z",
        )];
        let facts = codex_capability_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);

        let base = &facts[0];
        assert_eq!(base.capability_kind, AgentCapabilityKind::BaseInstructions);
        assert_eq!(base.item_count, 1);
        assert_eq!(base.stable_turn_index, 0);
        assert_eq!(base.redacted_label, "base instructions");
        assert_eq!(base.total_size_bytes, "You are Codex.".len() as i64);

        let tools = &facts[1];
        assert_eq!(tools.capability_kind, AgentCapabilityKind::DynamicTools);
        assert_eq!(tools.item_count, 3);
        assert_eq!(tools.stable_turn_index, 1);
        assert_eq!(tools.redacted_label, "3 dynamic tools");
    }

    #[test]
    fn distinct_kinds_get_distinct_ordinals_and_the_event_timestamp() {
        let records = [session_meta(
            json!({ "text": "prompt" }),
            json!([tool("a")]),
            "2026-05-16T20:53:00.000Z",
        )];
        let facts = codex_capability_facts(&records, &ctx());
        // 1 tool → singular label.
        assert_eq!(facts[1].redacted_label, "1 dynamic tool");
        for f in &facts {
            assert_eq!(f.event_at, 1_778_964_780_000);
            assert_eq!(f.source_snapshot_id, None);
            assert_eq!(f.dropped_sensitive, 0);
        }
        assert_ne!(facts[0].stable_turn_index, facts[1].stable_turn_index);
    }

    #[test]
    fn never_carries_raw_instruction_or_tool_text() {
        let secret_prompt = "SECRET BASE PROMPT TEXT";
        let records = [session_meta(
            json!({ "text": secret_prompt }),
            json!([tool("internal_tool")]),
            "2026-05-16T20:53:00.000Z",
        )];
        for f in codex_capability_facts(&records, &ctx()) {
            assert!(f.content_hash.starts_with("sha256:"));
            assert!(!f.content_hash.contains(secret_prompt));
            assert!(!f.redacted_label.contains(secret_prompt));
            assert!(!f.redacted_label.contains("internal_tool"));
        }
    }

    #[test]
    fn identical_surface_across_resumes_dedupes_to_one_row_per_kind() {
        // A resumed session re-states the same `session_meta` 24x (observed in real captures).
        let one = session_meta(
            json!({ "text": "stable prompt" }),
            json!([tool("a"), tool("b")]),
            "2026-05-16T20:53:00.000Z",
        );
        // Toolchain-agnostic clone-fill: avoids both the `repeat().take()` clippy lint and the
        // `repeat_n` MSRV floor (no `rust-version` is pinned here yet — see task 6a).
        let records: Vec<Value> = (0..24).map(|_| one.clone()).collect();
        let facts = codex_capability_facts(&records, &ctx());
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].stable_turn_index, 0);
        assert_eq!(facts[1].stable_turn_index, 1);
    }

    #[test]
    fn changed_surface_on_resume_lands_as_a_new_observation() {
        let records = [
            session_meta(
                json!({ "text": "prompt v1" }),
                json!([tool("a")]),
                "2026-05-16T20:53:00.000Z",
            ),
            session_meta(
                json!({ "text": "prompt v2" }),
                json!([tool("a")]),
                "2026-05-16T21:00:00.000Z",
            ),
        ];
        let facts = codex_capability_facts(&records, &ctx());
        // base v1, tools, base v2 (tools unchanged → deduped). 3 distinct observations.
        assert_eq!(facts.len(), 3);
        let base: Vec<_> = facts
            .iter()
            .filter(|f| f.capability_kind == AgentCapabilityKind::BaseInstructions)
            .collect();
        assert_eq!(base.len(), 2);
        assert_ne!(base[0].content_hash, base[1].content_hash);
        assert_ne!(base[0].stable_turn_index, base[1].stable_turn_index);
    }

    #[test]
    fn tool_reordering_with_same_set_dedupes() {
        let records = [
            session_meta(
                json!({ "text": "p" }),
                json!([tool("a"), tool("b"), tool("c")]),
                "2026-05-16T20:53:00.000Z",
            ),
            session_meta(
                json!({ "text": "p" }),
                json!([tool("c"), tool("a"), tool("b")]),
                "2026-05-16T21:00:00.000Z",
            ),
        ];
        let tools: Vec<_> = codex_capability_facts(&records, &ctx())
            .into_iter()
            .filter(|f| f.capability_kind == AgentCapabilityKind::DynamicTools)
            .collect();
        assert_eq!(tools.len(), 1);
    }

    #[test]
    fn content_hash_is_stable_across_reparse() {
        let records = [session_meta(
            json!({ "text": "deterministic" }),
            json!([tool("a"), tool("b")]),
            "2026-05-16T20:53:00.000Z",
        )];
        let first = codex_capability_facts(&records, &ctx());
        let second = codex_capability_facts(&records, &ctx());
        assert_eq!(first, second);
    }

    #[test]
    fn missing_dynamic_tools_emits_only_base() {
        let records = [json!({
            "type": "session_meta",
            "timestamp": "2026-05-16T20:53:00.000Z",
            "payload": { "id": "codex-sess-1", "base_instructions": { "text": "only base" } }
        })];
        let facts = codex_capability_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(
            facts[0].capability_kind,
            AgentCapabilityKind::BaseInstructions
        );
    }

    #[test]
    fn empty_dynamic_tools_array_emits_no_tools_observation() {
        let records = [session_meta(
            json!({ "text": "base" }),
            json!([]),
            "2026-05-16T20:53:00.000Z",
        )];
        let facts = codex_capability_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(
            facts[0].capability_kind,
            AgentCapabilityKind::BaseInstructions
        );
    }

    #[test]
    fn base_instructions_surface_is_trimmed_so_padding_dedupes() {
        let records = [
            session_meta(
                json!({ "text": "  prompt  " }),
                json!([]),
                "2026-05-16T20:53:00.000Z",
            ),
            session_meta(
                json!({ "text": "prompt" }),
                json!([]),
                "2026-05-16T21:00:00.000Z",
            ),
        ];
        let facts = codex_capability_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].total_size_bytes, "prompt".len() as i64);
    }

    #[test]
    fn empty_or_whitespace_base_instructions_is_absent() {
        for base in [json!({ "text": "   " }), json!({ "text": "" }), json!("")] {
            let records = [session_meta(
                base,
                json!([tool("a")]),
                "2026-05-16T20:53:00.000Z",
            )];
            let facts = codex_capability_facts(&records, &ctx());
            assert_eq!(facts.len(), 1);
            assert_eq!(facts[0].capability_kind, AgentCapabilityKind::DynamicTools);
        }
    }

    #[test]
    fn accepts_bare_string_base_instructions_from_older_codex() {
        let records = [session_meta(
            json!("legacy plain string prompt"),
            json!([]),
            "2026-05-16T20:53:00.000Z",
        )];
        let facts = codex_capability_facts(&records, &ctx());
        assert_eq!(facts.len(), 1);
        assert_eq!(
            facts[0].capability_kind,
            AgentCapabilityKind::BaseInstructions
        );
        assert_eq!(
            facts[0].total_size_bytes,
            "legacy plain string prompt".len() as i64
        );
    }

    #[test]
    fn falls_back_to_session_start_when_timestamp_missing() {
        let records = [json!({
            "type": "session_meta",
            "payload": { "base_instructions": { "text": "no ts" } }
        })];
        let facts = codex_capability_facts(&records, &ctx());
        assert_eq!(facts[0].event_at, 1_778_964_000_000);
    }

    #[test]
    fn non_meta_records_and_empty_session_emit_nothing() {
        let records = [json!({ "type": "turn_context", "payload": { "model": "gpt-5.5" } })];
        assert!(codex_capability_facts(&records, &ctx()).is_empty());
        assert!(codex_capability_facts(&[], &ctx()).is_empty());
    }
}
