// SPDX-License-Identifier: MIT
// Original Trace Flow code. The incremental-vs-history-import distinction echoes otto-sync's
// `SyncMode` (Backfill/Incremental/Watch, types.rs, ~/src/otto), but the 24-hour active-session
// grace window and the 7-day / 30-day / 1-year history presets are Trace Flow decisions from the
// ADR's first-run setup. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Which transcript files a sync pass should include, expressed as an **mtime cutoff**.
//!
//! Two entry points, both from the ADR's first-run setup:
//!
//! - [`ImportWindow::first_incremental`] — the default first scan. It includes files modified within
//!   the 24h *before* `collector_started_at`, the active-session grace window that catches
//!   conversations already in progress at install without turning first run into a historical
//!   import. Older files are out of scope until the user runs an explicit history import.
//! - [`ImportWindow::history`] — an explicit backfill for one of three presets ([`HistoryPreset`]).
//!   v1 has no "all history" import; the 1-year preset matches the fact-retention horizon, so
//!   importing older-than-retention data would be wasted.
//!
//! The window is a pure value: it carries one cutoff and answers [`includes`](ImportWindow::includes)
//! for a file's mtime. The discovery/drive layer (later 3b/3d) supplies the timestamps and applies
//! it; this module decides nothing about reading files or talking to the network.

const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

/// The active-session grace window for the first incremental scan: 24h, i.e. one day, before
/// `collector_started_at`. Derived from [`MS_PER_DAY`] so the two never drift to different values.
const GRACE_WINDOW_MS: i64 = MS_PER_DAY;

/// The three v1 history-import presets. There is deliberately no "all history" option (ADR): the
/// 1-year preset is the fact-retention horizon, and older data would not survive ingestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryPreset {
    Last7Days,
    Last30Days,
    LastYear,
}

impl HistoryPreset {
    /// How far back this preset reaches, in milliseconds.
    pub fn duration_ms(self) -> i64 {
        match self {
            HistoryPreset::Last7Days => 7 * MS_PER_DAY,
            HistoryPreset::Last30Days => 30 * MS_PER_DAY,
            HistoryPreset::LastYear => 365 * MS_PER_DAY,
        }
    }
}

/// A lower-bound mtime cutoff (epoch ms): a file is in scope iff its mtime is at or after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportWindow {
    cutoff_ms: i64,
}

impl ImportWindow {
    /// The default first incremental scan: the 24h grace window ending at `collector_started_at`.
    pub fn first_incremental(collector_started_at_ms: i64) -> Self {
        Self {
            cutoff_ms: collector_started_at_ms - GRACE_WINDOW_MS,
        }
    }

    /// An explicit history import of `preset`, measured back from `now`.
    pub fn history(preset: HistoryPreset, now_ms: i64) -> Self {
        Self {
            cutoff_ms: now_ms - preset.duration_ms(),
        }
    }

    /// The lower-bound mtime (epoch ms) this window admits.
    pub fn cutoff_ms(self) -> i64 {
        self.cutoff_ms
    }

    /// Whether a file with this mtime is in scope. Inclusive lower bound; `file_mtime_ms` is `f64`
    /// to match the filesystem's fractional `mtimeMs` (see [`FileCursor`](crate::cursor::FileCursor)).
    pub fn includes(self, file_mtime_ms: f64) -> bool {
        file_mtime_ms >= self.cutoff_ms as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A fixed reference instant so the arithmetic is obvious: 2026-05-27T00:00:00Z in epoch ms.
    const T: i64 = 1_779_840_000_000;

    #[test]
    fn first_incremental_cutoff_is_24h_before_start() {
        let w = ImportWindow::first_incremental(T);
        assert_eq!(w.cutoff_ms(), T - GRACE_WINDOW_MS);
    }

    #[test]
    fn grace_window_admits_an_in_progress_session_but_not_an_older_one() {
        let w = ImportWindow::first_incremental(T);
        // Edited 1h before start: an active session, in scope.
        assert!(w.includes((T - 60 * 60 * 1000) as f64));
        // Edited 25h before start: outside the grace window, needs explicit history import.
        assert!(!w.includes((T - 25 * 60 * 60 * 1000) as f64));
    }

    #[test]
    fn the_cutoff_is_an_inclusive_lower_bound() {
        let w = ImportWindow::first_incremental(T);
        assert!(w.includes(w.cutoff_ms() as f64));
        assert!(!w.includes(w.cutoff_ms() as f64 - 1.0));
    }

    #[test]
    fn history_presets_reach_the_expected_distance_back() {
        assert_eq!(
            ImportWindow::history(HistoryPreset::Last7Days, T).cutoff_ms(),
            T - 7 * MS_PER_DAY
        );
        assert_eq!(
            ImportWindow::history(HistoryPreset::Last30Days, T).cutoff_ms(),
            T - 30 * MS_PER_DAY
        );
        assert_eq!(
            ImportWindow::history(HistoryPreset::LastYear, T).cutoff_ms(),
            T - 365 * MS_PER_DAY
        );
    }

    #[test]
    fn a_year_import_reaches_further_back_than_the_grace_window() {
        // Sanity: the explicit import is what unlocks pre-grace history.
        let grace = ImportWindow::first_incremental(T).cutoff_ms();
        let year = ImportWindow::history(HistoryPreset::LastYear, T).cutoff_ms();
        assert!(year < grace);
    }
}
