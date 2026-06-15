import { describe, expect, it } from 'vitest';
import { buildBurnRateStats, buildPriorWindowParams, hasUsableBurnRateBuckets } from '../burnRate';
import type { AgentSummaryRow, AgentTimeseriesRow } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

function row(overrides: Partial<AgentTimeseriesRow> = {}): AgentTimeseriesRow {
  return {
    bucket_start: '2026-06-10 00:00:00',
    group_value: '',
    message_count: 10,
    session_count: 2,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 150,
    cost_usd: 20,
    priced_message_count: 10,
    tool_event_count: 0,
    tool_success_count: 0,
    tool_failure_count: 0,
    tool_unknown_count: 0,
    ...overrides,
  };
}

const summary: AgentSummaryRow = {
  estimated_cost_usd: 90,
  total_tokens: 9_000,
  message_count: 90,
  session_count: 9,
  priced_message_count: 90,
  coverage_pct: 1,
  prior_cost_usd: 45,
  prior_total_tokens: 4_500,
  prior_message_count: 45,
  prior_session_count: 5,
};

describe('burn rate helpers', () => {
  it('builds the prior equal-length window params', () => {
    expect(
      buildPriorWindowParams({
        start_time_ms: 1000,
        end_time_ms: 4000,
        sources: 'codex',
      }),
    ).toEqual({
      start_time_ms: -2000,
      end_time_ms: 1000,
      sources: 'codex',
    });
  });

  it('computes calendar, active-day, weekday, prior, and projection rates', () => {
    const filterParams = {
      start_time_ms: Date.UTC(2026, 5, 8),
      end_time_ms: Date.UTC(2026, 5, 11),
    };

    const stats = buildBurnRateStats({
      summary,
      currentRows: [
        row({ bucket_start: '2026-06-08 00:00:00', cost_usd: 30 }),
        row({ bucket_start: '2026-06-09 00:00:00', cost_usd: 30 }),
      ],
      priorRows: [row({ bucket_start: '2026-06-05 00:00:00', cost_usd: 45 })],
      filterParams,
    });

    expect(stats.calendarDays).toBe((3 * DAY_MS) / DAY_MS);
    expect(stats.activeDays).toBe(2);
    expect(stats.quietDays).toBe(1);
    expect(stats.weekdayActiveDays).toBe(2);
    expect(stats.costPerCalendarDay).toBe(30);
    expect(stats.costPerActiveDay).toBe(45);
    expect(stats.priorCostPerActiveDay).toBe(45);
    expect(stats.projectedThirtyDayCost).toBe(900);
  });

  it('counts calendar days in the viewer timezone, not a UTC span', () => {
    // A UTC-midnight start viewed from a timezone behind UTC lands on the previous local day,
    // so a 31-day UTC window can touch 32 local calendar days. Active days are counted in the
    // same local timezone, so calendarDays must be too — else "32 active of 31 in range".
    const stats = buildBurnRateStats({
      summary,
      currentRows: [],
      priorRows: [],
      filterParams: {
        start_time_ms: Date.UTC(2026, 4, 1),
        end_time_ms: Date.UTC(2026, 5, 1),
      },
      timezone: 'America/Los_Angeles',
    });

    expect(stats.calendarDays).toBe(32);
  });

  it('classifies day buckets in the query timezone', () => {
    const stats = buildBurnRateStats({
      summary,
      currentRows: [
        // 2026-06-07 15:00 UTC is 2026-06-08 00:00 Monday in Asia/Tokyo.
        row({ bucket_start: '2026-06-07 15:00:00', cost_usd: 30 }),
      ],
      priorRows: [],
      filterParams: {
        start_time_ms: Date.UTC(2026, 5, 7),
        end_time_ms: Date.UTC(2026, 5, 10),
      },
      timezone: 'Asia/Tokyo',
    });

    expect(stats.activeDays).toBe(1);
    expect(stats.weekdayActiveDays).toBe(1);
    expect(stats.costPerWeekdayActiveDay).toBe(30);
  });

  it('does not include weekend spend in the active-weekday cost rate', () => {
    const stats = buildBurnRateStats({
      summary,
      currentRows: [
        row({ bucket_start: '2026-06-08 00:00:00', cost_usd: 30 }),
        row({ bucket_start: '2026-06-13 00:00:00', cost_usd: 60 }),
      ],
      priorRows: [],
      filterParams: {
        start_time_ms: Date.UTC(2026, 5, 8),
        end_time_ms: Date.UTC(2026, 5, 15),
      },
      timezone: 'UTC',
    });

    expect(stats.activeDays).toBe(2);
    expect(stats.weekdayActiveDays).toBe(1);
    expect(stats.costPerActiveDay).toBe(45);
    expect(stats.costPerWeekdayActiveDay).toBe(30);
  });

  it('does not collapse zero active days to a synthetic one-day divisor', () => {
    const stats = buildBurnRateStats({
      summary,
      currentRows: [],
      priorRows: [],
      filterParams: {
        start_time_ms: Date.UTC(2026, 5, 8),
        end_time_ms: Date.UTC(2026, 5, 11),
      },
    });

    expect(stats.activeDays).toBe(0);
    expect(stats.weekdayActiveDays).toBe(0);
    expect(stats.costPerActiveDay).toBe(0);
    expect(stats.tokensPerActiveDay).toBe(0);
  });

  it('detects whether daily buckets contain any usable active day', () => {
    expect(hasUsableBurnRateBuckets([])).toBe(false);
    expect(
      hasUsableBurnRateBuckets([
        row({
          cost_usd: 0,
          total_tokens: 0,
          message_count: 0,
          session_count: 0,
        }),
      ]),
    ).toBe(false);
    expect(hasUsableBurnRateBuckets([row({ cost_usd: 1 })])).toBe(true);
  });
});
