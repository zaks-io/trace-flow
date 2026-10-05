// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code.

//! How long an embedder waits before its next sync pass after the ingest Worker shed load
//! (`429 rate_limited` or `503 enqueue_failed`).
//!
//! The Worker's `Retry-After` is a floor, never shortened. Jitter spreads collectors that were shed
//! together so they do not all return in the same second and close the gate again.

use std::time::Duration;

/// Used when a shed-load response carried no `Retry-After`. Matches the Worker's admission header.
pub const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(60);
/// Caps a hostile or mistaken `Retry-After` so one response cannot park a collector for days.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(60 * 60);

/// The wait before the next pass: the requested (or default) delay, capped, plus up to 50% jitter.
/// `jitter_unit` is a uniform sample in `[0, 1)`.
pub fn backoff_delay(retry_after: Option<Duration>, jitter_unit: f64) -> Duration {
    let base = retry_after
        .unwrap_or(DEFAULT_RETRY_AFTER)
        .min(MAX_RETRY_AFTER);
    base + base.mul_f64(0.5 * jitter_unit.clamp(0.0, 1.0))
}

/// A uniform sample in `[0, 1)` from the OS RNG. Jitter needs no cryptographic strength, so an RNG
/// failure degrades to no jitter rather than failing the sync loop.
pub fn jitter_unit() -> f64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0.0;
    }
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_is_a_floor_with_up_to_half_again_of_jitter() {
        let sixty = Some(Duration::from_secs(60));
        assert_eq!(backoff_delay(sixty, 0.0), Duration::from_secs(60));
        assert_eq!(backoff_delay(sixty, 0.5), Duration::from_secs(75));
        assert!(backoff_delay(sixty, 0.999_999) < Duration::from_secs(90));
    }

    #[test]
    fn a_missing_retry_after_uses_the_default_and_a_huge_one_is_capped() {
        assert_eq!(backoff_delay(None, 0.0), DEFAULT_RETRY_AFTER);
        assert_eq!(
            backoff_delay(Some(Duration::from_secs(86_400)), 0.0),
            MAX_RETRY_AFTER
        );
    }

    #[test]
    fn jitter_samples_stay_in_the_unit_interval() {
        for _ in 0..100 {
            let unit = jitter_unit();
            assert!((0.0..1.0).contains(&unit));
        }
    }
}
