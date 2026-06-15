import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTENTION_THRESHOLD_TOKENS,
  MAX_ATTENTION_THRESHOLD_TOKENS,
  buildContextHealthParams,
  contextHealthBand,
  formatContextTokens,
  resolveAttentionThreshold,
} from '../contextHealth';
import type { AgentContextHealthRow } from '../types';

function row(over: Partial<AgentContextHealthRow> = {}): AgentContextHealthRow {
  return {
    group_value: '',
    attention_threshold_tokens: DEFAULT_ATTENTION_THRESHOLD_TOKENS,
    model_call_count: 10,
    prior_model_call_count: 0,
    session_count: 2,
    prior_session_count: 0,
    first_call_context_p50: 50_000,
    prior_first_call_context_p50: 0,
    context_p10: 20_000,
    prior_context_p10: 0,
    context_p50: 80_000,
    prior_context_p50: 0,
    context_p90: 120_000,
    prior_context_p90: 0,
    context_p95: 130_000,
    prior_context_p95: 0,
    context_max: 135_000,
    prior_context_max: 0,
    calls_over_threshold: 0,
    prior_calls_over_threshold: 0,
    pct_calls_over_threshold: 0,
    prior_pct_calls_over_threshold: 0,
    sessions_over_threshold: 0,
    prior_sessions_over_threshold: 0,
    pct_sessions_over_threshold: 0,
    prior_pct_sessions_over_threshold: 0,
    context_overage_tokens: 0,
    prior_context_overage_tokens: 0,
    cost_while_over_threshold: 0,
    prior_cost_while_over_threshold: 0,
    output_tokens_while_over_threshold: 0,
    prior_output_tokens_while_over_threshold: 0,
    worst_session_pk: '',
    worst_session_context_max: 0,
    worst_session_calls_over_threshold: 0,
    ...over,
  };
}

describe('context health helpers', () => {
  it('defaults the attention threshold to 140k tokens', () => {
    expect(resolveAttentionThreshold(null)).toBe(DEFAULT_ATTENTION_THRESHOLD_TOKENS);
    expect(resolveAttentionThreshold('not-a-number')).toBe(DEFAULT_ATTENTION_THRESHOLD_TOKENS);
  });

  it('clamps configured attention thresholds to a positive bounded range', () => {
    expect(resolveAttentionThreshold('0')).toBe(1);
    expect(resolveAttentionThreshold('-10')).toBe(1);
    expect(resolveAttentionThreshold('100000.9')).toBe(100_000);
    expect(resolveAttentionThreshold('999999999')).toBe(MAX_ATTENTION_THRESHOLD_TOKENS);
  });

  it('formats context tokens with the shared compact number formatter', () => {
    expect(formatContextTokens(140_000)).toBe('140.0K tokens');
  });

  it('classifies empty, normal, and pressured context rows', () => {
    expect(contextHealthBand(null)).toBe('empty');
    expect(contextHealthBand(row({ model_call_count: 0 }))).toBe('empty');
    expect(contextHealthBand(row())).toBe('normal');
    expect(contextHealthBand(row({ calls_over_threshold: 1 }))).toBe('pressured');
    expect(contextHealthBand(row({ sessions_over_threshold: 1 }))).toBe('pressured');
  });

  it('builds Tinybird params with threshold, model filters, dimensions, and limits', () => {
    expect(
      buildContextHealthParams({
        filterParams: { start_time_ms: 1, end_time_ms: 2, sources: 'codex' },
        models: ['gpt-5.5'],
        attentionThresholdTokens: 100_000,
        dimension: 'repo',
        limit: 25,
      }),
    ).toEqual({
      start_time_ms: 1,
      end_time_ms: 2,
      sources: 'codex',
      models: 'gpt-5.5',
      attention_threshold_tokens: 100_000,
      dimension: 'repo',
      limit: 25,
    });
  });
});
