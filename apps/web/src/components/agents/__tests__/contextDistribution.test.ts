import { describe, expect, it } from 'vitest';
import { buildContextBins, CONTEXT_BIN_COUNT } from '../contextDistribution';
import type { AgentContextHealthRow } from '../types';

function makeRow(overrides: Partial<AgentContextHealthRow> = {}): AgentContextHealthRow {
  const zero = {
    group_value: '',
    attention_threshold_tokens: 140_000,
    model_call_count: 0,
    prior_model_call_count: 0,
    session_count: 0,
    prior_session_count: 0,
    first_call_context_p50: 0,
    prior_first_call_context_p50: 0,
    context_p10: 0,
    prior_context_p10: 0,
    context_p50: 0,
    prior_context_p50: 0,
    context_p90: 0,
    prior_context_p90: 0,
    context_p95: 0,
    prior_context_p95: 0,
    context_max: 0,
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
  } satisfies Omit<
    AgentContextHealthRow,
    | 'context_hist_bin_0'
    | 'context_hist_bin_1'
    | 'context_hist_bin_2'
    | 'context_hist_bin_3'
    | 'context_hist_bin_4'
    | 'context_hist_bin_5'
    | 'context_hist_bin_6'
    | 'context_hist_bin_7'
    | 'context_hist_bin_8'
    | 'context_hist_bin_9'
  >;
  const bins = Object.fromEntries(
    Array.from({ length: CONTEXT_BIN_COUNT }, (_, i) => [`context_hist_bin_${i}`, 0]),
  );
  return { ...zero, ...bins, ...overrides } as AgentContextHealthRow;
}

describe('buildContextBins', () => {
  it('maps the flat bin columns to ten labelled bins, low to high', () => {
    const row = makeRow({
      context_hist_bin_0: 3,
      context_hist_bin_1: 2,
      context_hist_bin_2: 1,
    });
    const bins = buildContextBins(row);

    expect(bins).toHaveLength(10);
    expect(bins[0]).toMatchObject({ start: 0, label: '0', count: 3 });
    expect(bins[1]).toMatchObject({ start: 100_000, label: '100K', count: 2 });
    expect(bins[2]).toMatchObject({ start: 200_000, label: '200K', count: 1 });
    expect(bins[9]).toMatchObject({ start: 900_000, label: '900K+', count: 0 });
  });

  it('treats the top bin as a >=900K catch-all', () => {
    const row = makeRow({ context_hist_bin_9: 5 });
    expect(buildContextBins(row)[9]).toMatchObject({ label: '900K+', count: 5 });
  });

  it('coerces missing bin columns to zero (stale-deploy safety)', () => {
    const row = makeRow();
    delete (row as Partial<AgentContextHealthRow>).context_hist_bin_1;
    expect(buildContextBins(row)[1]).toMatchObject({ label: '100K', count: 0 });
  });
});
