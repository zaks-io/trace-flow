import { describe, expect, it } from 'vitest';
import {
  costGapNote,
  estimatedCost,
  planLabel,
  reasoningShare,
  successRate,
  tokenCell,
  usageGapNote,
} from '../upstreamAccountUsage';
import type { UpstreamAccountRow } from '../types';

const row: UpstreamAccountRow = {
  account_key: 'abcdef01-0000-4000-8000-000000000001/openai/provider-account/' + 'd'.repeat(64),
  request_count: 2,
  error_count: 1,
  input_tokens: 140,
  uncached_input_tokens: 140,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  reasoning_tokens: 0,
  unclassified_tokens: 0,
  total_tokens: 190,
  usage_missing_count: 0,
  total_cost_usd: 0.012,
  cost_priced_count: 2,
  cost_partial_count: 0,
  cost_unpriced_count: 0,
  cost_unassessed_count: 0,
  cost_proxy_count: 0,
  cost_priced_tokens: 190,
  cost_coverage_ratio: 1,
  avg_ttft_ms: 200,
  first_received_ms: 1790856001000,
  last_received_ms: 1790856002000,
  plan: '',
};

const unavailable: UpstreamAccountRow = {
  ...row,
  request_count: 1,
  error_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  usage_missing_count: 1,
  total_cost_usd: 0,
  cost_priced_count: 0,
  cost_unpriced_count: 1,
  cost_priced_tokens: 0,
  cost_coverage_ratio: null,
};

describe('upstream account usage display', () => {
  it.each([
    [0, 0, '-'],
    [4, 0, '100%'],
    [4, 4, '0.0%'],
    [4, 1, '75%'],
    [3, 1, '67%'],
  ])('shows success rate for %i requests and %i failures', (requests, failures, expected) => {
    expect(successRate({ request_count: requests, error_count: failures })).toBe(expected);
  });

  it('shows missing usage and pricing as unavailable instead of zero', () => {
    expect(tokenCell(unavailable, unavailable.input_tokens)).toBe('-');
    expect(estimatedCost(unavailable)).toBeNull();
    expect(costGapNote(unavailable)).toBe('1 unpriced');
    expect(reasoningShare(unavailable)).toBe('-');
  });

  it('keeps known usage from failed executions and flags partial gaps beside the sums', () => {
    expect(tokenCell(row, row.input_tokens)).toBe('140');
    expect(estimatedCost(row)).toBe(0.012);
    expect(usageGapNote(row)).toBeNull();
    expect(reasoningShare({ ...row, output_tokens: 40, reasoning_tokens: 10 })).toBe('25%');

    const partial = { ...row, request_count: 3, usage_missing_count: 1, unclassified_tokens: 7 };
    expect(tokenCell(partial, partial.input_tokens)).toBe('140');
    expect(usageGapNote(partial)).toBe('1 without usage, 7 unclassified');
  });

  it('lists every incomplete pricing state', () => {
    expect(
      costGapNote({
        ...row,
        cost_partial_count: 1,
        cost_unpriced_count: 2,
        cost_unassessed_count: 3,
      }),
    ).toBe('1 partial, 2 unpriced, 3 not assessed');
    expect(costGapNote(row)).toBeNull();
    expect(costGapNote({ ...row, cost_partial_count: 1, cost_coverage_ratio: 0.5 })).toBe(
      '1 partial, 50% of tokens priced',
    );
  });

  it('labels a reported plan by product name and hides unknown or unrecognized plans', () => {
    expect(planLabel({ plan: 'claude_max_20x' })).toBe('Claude Max 20x');
    expect(planLabel({ plan: 'chatgpt_team' })).toBe('ChatGPT Business');
    expect(planLabel(row)).toBeNull();
    expect(planLabel({ plan: 'unknown' })).toBeNull();
    expect(planLabel({ plan: 'claude_max_40x' })).toBeNull();
  });
});
