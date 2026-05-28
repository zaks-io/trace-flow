import { describe, expect, it } from 'vitest';
import { rankBreakdown } from '../breakdown';
import { OTHER_GROUP } from '../pivot';
import type { AgentBreakdownRow } from '../types';

function row(group: string, over: Partial<AgentBreakdownRow>): AgentBreakdownRow {
  return {
    group_value: group,
    message_count: 0,
    session_count: 0,
    total_tokens: 0,
    cost_usd: 0,
    ...over,
  };
}

describe('rankBreakdown', () => {
  it('ranks by the active metric descending', () => {
    const rows = [row('a', { cost_usd: 1 }), row('b', { cost_usd: 9 }), row('c', { cost_usd: 5 })];
    expect(rankBreakdown(rows, 'cost_usd')).toEqual([
      { value: 'b', amount: 9 },
      { value: 'c', amount: 5 },
      { value: 'a', amount: 1 },
    ]);
  });

  it('ranks by a different metric column when selected', () => {
    const rows = [
      row('a', { cost_usd: 1, message_count: 100 }),
      row('b', { cost_usd: 9, message_count: 1 }),
    ];
    expect(rankBreakdown(rows, 'message_count')).toEqual([
      { value: 'a', amount: 100 },
      { value: 'b', amount: 1 },
    ]);
  });

  it('collapses the tail into Other when over top-N', () => {
    const rows = [
      row('a', { cost_usd: 100 }),
      row('b', { cost_usd: 50 }),
      row('c', { cost_usd: 5 }),
      row('d', { cost_usd: 3 }),
    ];
    expect(rankBreakdown(rows, 'cost_usd', 2)).toEqual([
      { value: 'a', amount: 100 },
      { value: 'b', amount: 50 },
      { value: OTHER_GROUP, amount: 8 },
    ]);
  });

  it('does not add Other when rows fit within top-N', () => {
    const rows = [row('a', { cost_usd: 1 }), row('b', { cost_usd: 2 })];
    const ranked = rankBreakdown(rows, 'cost_usd', 5);
    expect(ranked.map((e) => e.value)).toEqual(['b', 'a']);
  });
});
