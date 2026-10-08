import { describe, expect, it } from 'vitest';
import { buildDailyUsage } from '../dailyUsage';
import type { AgentTimeseriesRow } from '../types';

function row(bucket_start: string, tokens = 150, cost = 2): AgentTimeseriesRow {
  return {
    bucket_start,
    group_value: '',
    message_count: 1,
    session_count: 1,
    input_tokens: tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: tokens,
    cost_usd: cost,
    priced_message_count: 1,
    tool_event_count: 0,
    tool_success_count: 0,
    tool_failure_count: 0,
    tool_unknown_count: 0,
  };
}

describe('daily usage labels', () => {
  it.each([
    ['Asia/Tokyo', '2026-06-09 15:00:00'],
    ['Asia/Kolkata', '2026-06-09 18:30:00'],
    ['America/Los_Angeles', '2026-06-10 07:00:00'],
    ['UTC', '2026-06-10 00:00:00'],
  ])('labels local-midnight buckets in %s', (timezone, bucket) => {
    expect(buildDailyUsage([row(bucket)], timezone)).toEqual([
      { label: '2026-06-10', tokens: 150, cost: 2 },
    ]);
  });

  it('sorts local dates and combines grouped totals across a year boundary', () => {
    expect(
      buildDailyUsage(
        [
          row('2026-01-01 15:00:00'),
          row('2025-12-31 15:00:00'),
          { ...row('2025-12-31T15:00:00Z', 50, 1), group_value: 'codex' },
        ],
        'Asia/Tokyo',
      ),
    ).toEqual([
      { label: '2026-01-01', tokens: 200, cost: 3 },
      { label: '2026-01-02', tokens: 150, cost: 2 },
    ]);
  });

  it('keeps consecutive local days across daylight-saving changes', () => {
    expect(
      buildDailyUsage(
        [row('2026-03-08 08:00:00'), row('2026-03-09 07:00:00')],
        'America/Los_Angeles',
      ).map(({ label }) => label),
    ).toEqual(['2026-03-08', '2026-03-09']);
  });

  it('returns no points for an empty series', () => {
    expect(buildDailyUsage([], 'UTC')).toEqual([]);
  });
});
