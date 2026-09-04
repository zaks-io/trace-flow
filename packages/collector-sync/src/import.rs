// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. The incremental-vs-history-import distinction echoes otto-sync's
// `SyncMode` (Backfill/Incremental/Watch, types.rs, ~/src/otto), but the 24-hour active-session
// grace window and the 7-day / 30-day / 1-year history presets are Trace Flow decisions from the
// ADR's first-run setup. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Which transcript files a sync pass should include, expressed as an **mtime cutoff**.
//!
//! Three entry points:
//!
//! - [`ImportWindow::first_incremental`] — the default first scan. It includes files modified within
//!   the 24h *before* `collector_started_at`, the active-session grace window that catches
//!   conversations already in progress at install without turning first run into a historical
//!   import. Older files are out of scope until the user runs an explicit history import.
//! - [`ImportWindow::resume_incremental`] — every later incremental scan. The same grace window, but
//!   measured back from the last *complete* sync rather than from now, so files changed while the
//!   collector was not running (a relaunch, a closed laptop, a paused app) stay in scope instead of
//!   being skipped forever.
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

    /// An incremental scan that resumes from the last complete sync: the grace window before
    /// `last_complete_sync_at_ms`, not before `now_ms`, so downtime between syncs is covered. Floored
    /// at the 1-year retention horizon, past which ingestion would not keep the data anyway. A
    /// watermark in the future (clock skew) is clamped to `now_ms` so it can never exclude fresh files.
    pub fn resume_incremental(last_complete_sync_at_ms: i64, now_ms: i64) -> Self {
        let resumed_from = last_complete_sync_at_ms.min(now_ms) - GRACE_WINDOW_MS;
        let retention_floor = now_ms - HistoryPreset::LastYear.duration_ms();
        Self {
            cutoff_ms: resumed_from.max(retention_floor),
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
    fn resume_incremental_reaches_back_to_the_grace_before_the_last_complete_sync() {
        let thirteen_days_ago = T - 13 * MS_PER_DAY;
        let w = ImportWindow::resume_incremental(thirteen_days_ago, T);
        assert_eq!(w.cutoff_ms(), thirteen_days_ago - GRACE_WINDOW_MS);
        // A file edited 10 days ago, while the collector was down, is back in scope.
        assert!(w.includes((T - 10 * MS_PER_DAY) as f64));
    }

    #[test]
    fn resume_incremental_is_floored_at_the_retention_horizon() {
        let two_years_ago = T - 730 * MS_PER_DAY;
        let w = ImportWindow::resume_incremental(two_years_ago, T);
        assert_eq!(
            w.cutoff_ms(),
            ImportWindow::history(HistoryPreset::LastYear, T).cutoff_ms()
        );
    }

    #[test]
    fn resume_incremental_never_trusts_a_future_watermark() {
        let w = ImportWindow::resume_incremental(T + MS_PER_DAY, T);
        assert_eq!(
            w.cutoff_ms(),
            ImportWindow::first_incremental(T).cutoff_ms()
        );
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
