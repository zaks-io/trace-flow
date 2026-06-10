// SPDX-License-Identifier: MIT
// Original Trace Flow code (no otto equivalent: otto resolved this metadata inline in its per-source
// parsers). Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Per-session metadata the fact emitters need but the transcript records do not carry. The sync
//! layer (`collector-sync`) resolves it once per session — the git remote it froze for the session's
//! `cwd`, the credential's `agent_id`, the session's vendor ID — and hands it to every emitter so the
//! emitted [`AgentMessageFact`](collector_contracts::facts::AgentMessageFact) and its siblings share
//! one consistent identity. Emitters never invent these; an absent value is the empty string (or
//! `None` for `vendor_started_at`), which the ingest Worker resolves into the final `*_pk`.

/// Session-level context shared by every fact an emitter produces for one parsed session.
///
/// `normalized_git_remote` is the frozen remote string (e.g. `github.com/acme/trace-flow`) the sync
/// layer resolved for the session's working directory; `repo_path_fallback` is the coarse path label
/// used when no remote exists (the ingest Worker hashes one or the other into `repo_fingerprint`).
/// `agent_id` identifies the connected collector, not a sub-agent. `vendor_started_at` is the
/// session's start instant in epoch milliseconds when the transcript records it. `agent_depth` is the
/// transcript's nesting depth: `0` for a top-level session, `> 0` for a sub-agent transcript the sync
/// layer discovered in a nested file (Claude stores those as separate `subagents/<agent>.jsonl` files
/// linked to the parent `session_pk`; Codex sub-agents share the parent transcript, so its sessions
/// stay at `0`).
///
/// `repo_root` is the sole field that is *not* emitted onto a fact: it is the absolute repo directory
/// the sync layer resolved for the session (the git root it walked up to from the session `cwd`, the
/// same walk that froze `normalized_git_remote`), used only as the anchor that
/// [`relativize_repo_path`](crate::paths::relativize_repo_path) strips off every touched file path so
/// `agent_file_event_facts` store a repo-relative path and never a home dir or username. An empty
/// `repo_root` is "root unknown", which makes every absolute path collapse to the `outside_repo`
/// sentinel rather than leak — the safe default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionContext {
    pub vendor_session_id: String,
    pub agent_id: String,
    pub normalized_git_remote: String,
    pub repo_path_fallback: String,
    pub git_branch: String,
    pub git_head_sha: String,
    pub vendor_started_at: Option<i64>,
    pub agent_depth: i64,
    pub repo_root: String,
}
