// SPDX-License-Identifier: MIT
// Vendored and refactored from otto-parser/src/lib.rs (~/src/otto, 2026-05-25).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

//! Trace Flow Collector parser.
//!
//! Turns local coding-agent transcripts (Claude Code, Codex CLI) into the typed `Agent*Fact` shapes
//! defined in `collector-contracts`. It ships tokens + model only: never a cost (pricing is
//! server-side in the consumer) and never a final `*_pk` (identity is assembled by the ingest
//! Worker).
//!
//! `redaction` is the *primary* redaction trust boundary. The ingest Worker re-runs the same shared
//! canary corpus (`fixtures/redaction-canary.json`) as a backstop, so the two layers must agree —
//! see `apps/agent-ingest/src/redaction.ts`.

pub mod claude_usage;
pub mod codex_turns;
pub mod codex_usage;
pub mod command;
pub mod emit_claude;
pub mod emit_claude_files;
pub mod emit_claude_tools;
pub mod emit_codex;
pub mod emit_codex_files;
pub mod emit_codex_tools;
pub mod paths;
pub mod redaction;
pub mod session_context;
pub mod timestamp;
pub mod tool_fold;
