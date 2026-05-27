// SPDX-License-Identifier: MIT
// Replaces otto-parser/src/parser/normalize.rs `timestamp_ms` (~/src/otto, 2026-05-25), which leaned on
// `chrono::DateTime::parse_from_rfc3339`. Trace Flow drops the dependency: `chrono` is not in the
// workspace lock, the parser crate keeps a deliberately tiny pinned dependency surface (it is the
// redaction trust boundary), and `event_at` only ever comes from the fixed `YYYY-MM-DDTHH:MM:SS.sssZ`
// shape Claude Code and Codex CLI write. So this is an original, dependency-free reimplementation
// rather than vendored code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! RFC 3339 timestamp parsing. [`rfc3339_to_epoch_ms`] turns a transcript record's `timestamp` string
//! into the epoch-millisecond `event_at` every `Agent*Fact` carries. Both supported sources emit UTC
//! (`Z`) with millisecond precision, but the parser also accepts a numeric `±HH:MM` offset and any
//! fractional-second width so a format tweak on either source does not silently drop timestamps.

/// Days from the Unix epoch (1970-01-01) to a proleptic-Gregorian `(year, month, day)`, by Howard
/// Hinnant's `days_from_civil` algorithm. Valid for the full `i64` year range with no branches on
/// leap years; the caller validates the month/day ranges first.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    // Shift so March is month 0; the year's extra days then live at the end, past the leap day.
    let month_of_year = (month + 9) % 12;
    let day_of_year = (153 * month_of_year + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Whether `(year, month, day)` is a real calendar date. `days_from_civil` does no validation — it
/// would silently roll `2026-02-30` forward into March — so the parser screens dates here, with
/// month-specific lengths and the full Gregorian leap-year rule, before trusting the conversion.
fn is_valid_calendar_date(year: i64, month: i64, day: i64) -> bool {
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            if leap {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    (1..=days_in_month).contains(&day)
}

/// Parses up to the first three fractional-second digits as milliseconds: `"5"` → 500, `"89"` → 890,
/// `"892"` → 892, `"892123"` → 892 (extra digits truncated, never rounded). Empty fraction is 0; any
/// non-digit character rejects the whole timestamp.
fn fraction_to_millis(fraction: &str) -> Option<i64> {
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut millis = 0i64;
    for place in 0..3 {
        millis *= 10;
        if let Some(digit) = fraction.as_bytes().get(place) {
            millis += i64::from(digit - b'0');
        }
    }
    Some(millis)
}

/// Splits an RFC 3339 time-of-day from its trailing zone designator, returning the bare `HH:MM:SS[.fff]`
/// and the zone's offset from UTC in milliseconds (`Z` → 0, `+HH:MM` positive, `-HH:MM` negative). RFC
/// 3339 requires a zone, so a string with none is rejected.
fn split_zone(time_and_zone: &str) -> Option<(&str, i64)> {
    if let Some(time) = time_and_zone.strip_suffix(['Z', 'z']) {
        return Some((time, 0));
    }
    // The time-of-day carries no sign, so the last +/- is the zone sign and never part of the time.
    let sign_pos = time_and_zone.rfind(['+', '-'])?;
    let sign = if time_and_zone.as_bytes()[sign_pos] == b'-' {
        -1
    } else {
        1
    };
    // RFC 3339 offsets are exactly `(+|-)HH:MM` — both parts required, no seconds. Rejecting a missing
    // minutes field (`+02`) and an extra component (`+02:00:30`) stops malformed offsets parsing to a
    // plausible-but-wrong epoch.
    let mut zone = time_and_zone[sign_pos + 1..].split(':');
    let hours: i64 = zone.next()?.parse().ok()?;
    let minutes: i64 = zone.next()?.parse().ok()?;
    if zone.next().is_some() || !(0..=23).contains(&hours) || !(0..=59).contains(&minutes) {
        return None;
    }
    let offset_ms = sign * (hours * 3600 + minutes * 60) * 1000;
    Some((&time_and_zone[..sign_pos], offset_ms))
}

/// Parses an RFC 3339 / ISO 8601 timestamp (e.g. `"2026-05-26T16:38:59.892Z"`) into epoch
/// milliseconds, or `None` if it is malformed. The date and time are separated by `T`/`t`/space; the
/// zone offset is normalized away so the result is always UTC. A leap second (`:60`) is accepted only
/// at 23:59.
pub fn rfc3339_to_epoch_ms(timestamp: &str) -> Option<i64> {
    let separator = timestamp.find(['T', 't', ' '])?;
    let date = &timestamp[..separator];
    let (time, offset_ms) = split_zone(&timestamp[separator + 1..])?;

    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !is_valid_calendar_date(year, month, day) {
        return None;
    }

    let mut time_parts = time.split(':');
    let hours: i64 = time_parts.next()?.parse().ok()?;
    let minutes: i64 = time_parts.next()?.parse().ok()?;
    let seconds_field = time_parts.next()?;
    if time_parts.next().is_some() {
        return None;
    }
    let (seconds, fraction) = seconds_field.split_once('.').unwrap_or((seconds_field, ""));
    let seconds: i64 = seconds.parse().ok()?;
    let millis = fraction_to_millis(fraction)?;
    if !(0..=23).contains(&hours) || !(0..=59).contains(&minutes) || !(0..=60).contains(&seconds) {
        return None;
    }
    // A leap second (`:60`) is only legal at 23:59 UTC; `:60` anywhere else is a malformed time, not a
    // second to silently roll into the next minute. (Offset zones shift the wall clock, but agent
    // transcripts stamp UTC `Z`, so guarding on the parsed HH:MM is correct in practice.)
    if seconds == 60 && (hours, minutes) != (23, 59) {
        return None;
    }

    let day_seconds =
        days_from_civil(year, month, day) * 86_400 + hours * 3600 + minutes * 60 + seconds;
    Some(day_seconds * 1000 + millis - offset_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_epoch() {
        assert_eq!(rfc3339_to_epoch_ms("1970-01-01T00:00:00.000Z"), Some(0));
    }

    #[test]
    fn parses_real_claude_and_codex_timestamps() {
        // Ground truth from `date -j -u`.
        assert_eq!(
            rfc3339_to_epoch_ms("2026-05-26T16:38:59.892Z"),
            Some(1_779_813_539_892)
        );
        assert_eq!(
            rfc3339_to_epoch_ms("2026-05-16T20:53:10.631Z"),
            Some(1_778_964_790_631)
        );
    }

    #[test]
    fn handles_leap_day_and_year_boundary() {
        assert_eq!(
            rfc3339_to_epoch_ms("2000-02-29T12:00:00.000Z"),
            Some(951_825_600_000)
        );
        assert_eq!(
            rfc3339_to_epoch_ms("1999-12-31T23:59:59.999Z"),
            Some(946_684_799_999)
        );
        assert_eq!(
            rfc3339_to_epoch_ms("2026-01-01T00:00:00.000Z"),
            Some(1_767_225_600_000)
        );
    }

    #[test]
    fn fractional_seconds_truncate_to_milliseconds() {
        let base = 1_767_225_600_000;
        assert_eq!(rfc3339_to_epoch_ms("2026-01-01T00:00:00Z"), Some(base));
        assert_eq!(
            rfc3339_to_epoch_ms("2026-01-01T00:00:00.5Z"),
            Some(base + 500)
        );
        assert_eq!(
            rfc3339_to_epoch_ms("2026-01-01T00:00:00.89Z"),
            Some(base + 890)
        );
        // Sub-millisecond digits are dropped, not rounded up.
        assert_eq!(
            rfc3339_to_epoch_ms("2026-01-01T00:00:00.892999Z"),
            Some(base + 892)
        );
    }

    #[test]
    fn normalizes_numeric_offsets_to_utc() {
        let utc = rfc3339_to_epoch_ms("2026-01-01T00:00:00.000Z").unwrap();
        // 02:00 at +02:00 is the same instant as 00:00Z.
        assert_eq!(
            rfc3339_to_epoch_ms("2026-01-01T02:00:00.000+02:00"),
            Some(utc)
        );
        // 19:00 the previous day at -05:00 is also 00:00Z.
        assert_eq!(
            rfc3339_to_epoch_ms("2025-12-31T19:00:00.000-05:00"),
            Some(utc)
        );
    }

    #[test]
    fn accepts_a_leap_second() {
        assert_eq!(
            rfc3339_to_epoch_ms("2016-12-31T23:59:60.000Z"),
            Some(1_483_228_800_000)
        );
    }

    #[test]
    fn rejects_malformed_input() {
        for bad in [
            "",
            "not-a-timestamp",
            "2026-05-26",                   // date only, no time
            "2026-05-26T16:38:59.892",      // no zone
            "2026-13-01T00:00:00Z",         // month out of range
            "2026-05-32T00:00:00Z",         // day out of range
            "2026-02-30T00:00:00Z",         // February never has 30 days
            "2026-04-31T00:00:00Z",         // April has only 30 days
            "2026-02-29T00:00:00Z",         // 2026 is not a leap year
            "1900-02-29T00:00:00Z",         // century non-leap year (÷100, not ÷400)
            "2026-05-26T24:00:00Z",         // hour out of range
            "2026-05-26T16:60:00Z",         // minute out of range
            "2026-05-26T16:38:5xZ",         // non-numeric second
            "2026-05-26T16:38:59.8x2Z",     // non-numeric fraction
            "2026-05-26T16:38:59+02",       // offset missing minutes
            "2026-05-26T16:38:59+02:00:30", // offset has a seconds component
            "2026-05-26T12:30:60Z",         // `:60` only legal at 23:59
        ] {
            assert_eq!(rfc3339_to_epoch_ms(bad), None, "expected None for {bad:?}");
        }
    }
}
