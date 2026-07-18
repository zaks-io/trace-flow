import { describe, expect, it } from 'vitest';
import { modelOptionsFromRows } from '../useAgentModelOptions';
import type { AgentUsageBreakdownRow } from '../types';

function row(groupValue: string): AgentUsageBreakdownRow {
  return {
    group_value: groupValue,
    message_count: 1,
    session_count: 1,
    total_tokens: 1,
    cost_usd: 1,
  };
}

describe('modelOptionsFromRows', () => {
  it('returns discovered model values without empty or duplicate entries', () => {
    expect(
      modelOptionsFromRows([
        row('gpt-5.6-sol'),
        row(''),
        row('claude-opus-4-7'),
        row('gpt-5.6-sol'),
      ]),
    ).toEqual(['gpt-5.6-sol', 'claude-opus-4-7']);
  });
});
