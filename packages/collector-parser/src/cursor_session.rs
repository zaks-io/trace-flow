// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Cursor stores no per-session `cwd` (composerData.cwd is null), so unlike
// the Claude/Codex session readers there is no working directory to resolve a repo from — attribution
// is reconstructed from the file paths the session's tools touched. Trace Flow owns the contract, IDs,
// pricing, redaction, and storage around this code.

//! Cursor session-header field extraction.
//!
//! A Cursor session is one `composerData:` row; its messages are the `bubbleId:` rows the reader has
//! already grouped, ordered, and stamped with the session's composer id (`__composer_id`) and
//! session-grain model (`__model`). This module pulls the session-level identity the emitters need out
//! of those normalized records — pure, `Value`-based, no I/O — exactly as `claude_session` / Codex's
//! `session_meta` reader do for the JSONL sources, so the sync layer can build a `SessionContext`.
//!
//! **Model is session-grain.** Cursor records the model once, on the composer (`modelConfig.modelName`),
//! never per bubble (`bubble.modelType`/`role` are null). The reader copies it onto every bubble as
//! `__model`; [`cursor_session_fields`] reads it from the first record, the canonical value for the
//! whole session. The raw label ships through unchanged — normalization + pricing are server-side
//! (`apps/agent-consumer/src/pricing.ts`), so a Cursor-specific or unpriceable label (`composer-2-fast`,
//! `default`, `gpt-5.2-xhigh`) is never mangled or priced here.
//!
//! **Repo attribution is best-effort.** With no session `cwd`, [`cursor_repo_hint`] derives a candidate
//! repo root from the absolute file paths the session's `read_file`/`edit_file` tools touched (their
//! longest common directory prefix). The hint is only ever the anchor `relativize_repo_path` strips off
//! a touched path — it is never itself emitted — so when no common root is found the sync layer leaves
//! `repo_root` empty and every absolute path collapses to the `outside_repo` sentinel: the safe default.

use serde_json::Value;

use crate::cursor_records::{bubble_model, composer_id, tool_blocks, ToolBlock};

/// The session-level identity the sync layer maps onto a `SessionContext`. The model is the raw,
/// un-normalized Cursor label (server prices it); an empty string means the composer named no model or
/// named the house `default` (which carries no economic meaning and prices to null).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CursorSessionFields {
    /// The `composerData:` id — the vendor session id every fact carries.
    pub vendor_session_id: String,
    /// Raw `modelConfig.modelName`, applied to every message of the session. Empty for `default`/absent.
    pub model: String,
    /// The composer's `createdAt` (epoch ms) when the reader captured one — the session start instant.
    pub vendor_started_at: Option<i64>,
}

/// House labels with no economic meaning: Cursor's "let Cursor pick" default never names a real model,
/// so it is treated as "no model" rather than shipped as a literal that the server would try to price.
fn is_house_default(model: &str) -> bool {
    model.is_empty() || model == "default"
}

/// Pull the session header off the reader-normalized records. `composer_id` and `model` are stamped on
/// every bubble identically, so the first record is sufficient; `vendor_started_at` rides the reader's
/// injected `__started_at` (the composer's `createdAt`).
pub fn cursor_session_fields(records: &[Value]) -> CursorSessionFields {
    let first = records.first();
    let vendor_session_id = first.and_then(composer_id).unwrap_or_default().to_string();
    let raw_model = first.and_then(bubble_model).unwrap_or_default();
    let model = if is_house_default(raw_model) {
        String::new()
    } else {
        raw_model.to_string()
    };
    let vendor_started_at = first
        .and_then(|r| r.get("__started_at"))
        .and_then(Value::as_i64);
    CursorSessionFields {
        vendor_session_id,
        model,
        vendor_started_at,
    }
}

/// A best-effort repo-root candidate for the session: the longest common directory prefix of the
/// absolute file paths the session's tools touched. `None` when the session touched no file with an
/// absolute path (a chat-only session, or one whose tools carried no path) — the sync layer then leaves
/// `repo_root` empty and every path relativizes to `outside_repo`.
///
/// This is only ever fed to `relativize_repo_path` as the strip anchor; it is never emitted, so a wrong
/// guess can at worst widen what counts as "outside the repo", never leak a path.
pub fn cursor_repo_hint(records: &[Value]) -> Option<String> {
    let mut paths = records
        .iter()
        .flat_map(tool_blocks)
        .filter_map(|block: ToolBlock| block.target_file)
        .filter(|p| p.starts_with('/'))
        .map(|p| p.to_string())
        .peekable();
    paths.peek()?;
    let mut prefix: Option<Vec<String>> = None;
    for path in paths {
        let segments: Vec<String> = path
            .trim_end_matches('/')
            .split('/')
            .map(str::to_string)
            .collect();
        // Drop the file basename: the common *directory* prefix is the candidate root, not a shared file.
        let dir = &segments[..segments.len().saturating_sub(1)];
        prefix = Some(match prefix {
            None => dir.to_vec(),
            Some(acc) => acc
                .iter()
                .zip(dir)
                .take_while(|(a, b)| a == b)
                .map(|(a, _)| a.clone())
                .collect(),
        });
    }
    let segments = prefix?;
    // A degenerate `["", ""]` (only the leading `/` survived) is not a usable root — treat it as none so
    // the safe `outside_repo` default applies rather than anchoring on `/`.
    if segments.iter().all(String::is_empty) {
        return None;
    }
    Some(segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor_records::tests::{bubble, with_started_at};
    use serde_json::json;

    #[test]
    fn reads_session_id_and_model_from_the_first_record() {
        let records = [
            bubble("comp-1", "gpt-5.2-codex-high", 2, json!({})),
            bubble("comp-1", "gpt-5.2-codex-high", 1, json!({})),
        ];
        let fields = cursor_session_fields(&records);
        assert_eq!(fields.vendor_session_id, "comp-1");
        assert_eq!(fields.model, "gpt-5.2-codex-high");
    }

    #[test]
    fn the_house_default_label_is_treated_as_no_model() {
        let records = [bubble("comp-1", "default", 2, json!({}))];
        assert_eq!(cursor_session_fields(&records).model, "");
    }

    #[test]
    fn an_unpriceable_house_label_still_ships_raw() {
        // `composer-2-fast` has no catalog entry, but the server decides that — the parser must pass it
        // through untouched so the dashboard can show the real label with a null cost.
        let records = [bubble("comp-1", "composer-2-fast", 2, json!({}))];
        assert_eq!(cursor_session_fields(&records).model, "composer-2-fast");
    }

    #[test]
    fn started_at_rides_the_reader_injected_field() {
        let records = [with_started_at(
            bubble("comp-1", "gpt-5.2", 2, json!({})),
            1_777_000_000_000,
        )];
        assert_eq!(
            cursor_session_fields(&records).vendor_started_at,
            Some(1_777_000_000_000)
        );
    }

    #[test]
    fn empty_session_has_empty_fields() {
        let fields = cursor_session_fields(&[]);
        assert_eq!(fields.vendor_session_id, "");
        assert_eq!(fields.model, "");
        assert_eq!(fields.vendor_started_at, None);
    }

    #[test]
    fn repo_hint_is_the_common_dir_prefix_of_touched_files() {
        let records = [
            bubble(
                "c",
                "m",
                2,
                json!({ "toolFormerData": { "name": "read_file_v2", "status": "completed",
                    "params": "{\"targetFile\":\"/work/trace-flow/src/a.rs\"}" } }),
            ),
            bubble(
                "c",
                "m",
                2,
                json!({ "toolFormerData": { "name": "edit_file_v2", "status": "completed",
                    "params": "{\"targetFile\":\"/work/trace-flow/src/sub/b.rs\"}" } }),
            ),
        ];
        assert_eq!(
            cursor_repo_hint(&records).as_deref(),
            Some("/work/trace-flow/src")
        );
    }

    #[test]
    fn repo_hint_is_none_without_absolute_paths() {
        let records = [bubble("c", "m", 2, json!({}))];
        assert_eq!(cursor_repo_hint(&records), None);
    }
}
