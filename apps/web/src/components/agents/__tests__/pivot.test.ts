import { describe, expect, it } from 'vitest';
import { OTHER_GROUP, pivotByGroup } from '../pivot';
import type { AgentTimeseriesRow } from '../types';

function row(bucket: string, group: string, over: Partial<AgentTimeseriesRow>): AgentTimeseriesRow {
  return {
    bucket_start: bucket,
    group_value: group,
    message_count: 0,
    session_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    priced_message_count: 0,
    tool_event_count: 0,
    tool_success_count: 0,
    tool_failure_count: 0,
    tool_unknown_count: 0,
    ...over,
  };
}

describe('pivotByGroup', () => {
  it('pivots long group rows into one wide row per bucket, keyed by group value', () => {
    const rows = [
      row('2026-05-20 09:00:00', 'claude', { cost_usd: 2 }),
      row('2026-05-20 09:00:00', 'codex', { cost_usd: 1 }),
      row('2026-05-20 10:00:00', 'claude', { cost_usd: 3 }),
    ];
    const { data, groups } = pivotByGroup(rows, 'cost_usd');

    expect(groups).toEqual(['claude', 'codex']); // ordered by total desc (5 vs 1)
    expect(data).toEqual([
      { bucket_start: '2026-05-20 09:00:00', claude: 2, codex: 1 },
      { bucket_start: '2026-05-20 10:00:00', claude: 3, codex: 0 }, // zero-filled missing group
    ]);
  });

  it('orders groups by total metric value descending', () => {
    const rows = [
      row('b1', 'small', { total_tokens: 10 }),
      row('b1', 'big', { total_tokens: 100 }),
    ];
    const { groups } = pivotByGroup(rows, 'total_tokens');
    expect(groups).toEqual(['big', 'small']);
  });

  it('drops rows with an empty group_value (ungrouped / cross-dimension-unmatched)', () => {
    const rows = [
      row('b1', '', { tool_event_count: 9 }),
      row('b1', 'claude', { tool_event_count: 4 }),
    ];
    const { data, groups } = pivotByGroup(rows, 'tool_event_count');
    expect(groups).toEqual(['claude']);
    expect(data).toEqual([{ bucket_start: 'b1', claude: 4 }]);
  });

  it('returns empty groups when every row is ungrouped', () => {
    const rows = [row('b1', '', { cost_usd: 5 })];
    expect(pivotByGroup(rows, 'cost_usd')).toEqual({ data: [], groups: [] });
  });

  it('caps at top-N by total and rolls the rest into an Other series', () => {
    const rows = [
      row('b1', 'a', { cost_usd: 100 }),
      row('b1', 'b', { cost_usd: 50 }),
      row('b1', 'c', { cost_usd: 5 }),
      row('b1', 'd', { cost_usd: 3 }),
    ];
    const { data, groups } = pivotByGroup(rows, 'cost_usd', 2);
    expect(groups).toEqual(['a', 'b', OTHER_GROUP]);
    expect(data).toEqual([{ bucket_start: 'b1', a: 100, b: 50, [OTHER_GROUP]: 8 }]);
  });

  it('does not add an Other series when groups fit within top-N', () => {
    const rows = [row('b1', 'a', { cost_usd: 1 }), row('b1', 'b', { cost_usd: 2 })];
    const { groups } = pivotByGroup(rows, 'cost_usd', 5);
    expect(groups).toEqual(['b', 'a']);
    expect(groups).not.toContain(OTHER_GROUP);
  });
});
