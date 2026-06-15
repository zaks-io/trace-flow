import { describe, expect, it } from 'vitest';
import { buildAttentionSignals } from '../buildAttentionSignals';
import type { AgentContextHealthRow, AgentSummaryRow, FailureLeaderboardRow } from '../types';

function summary(overrides: Partial<AgentSummaryRow> = {}): AgentSummaryRow {
  return {
    estimated_cost_usd: 100,
    total_tokens: 10_000,
    message_count: 100,
    session_count: 10,
    priced_message_count: 100,
    coverage_pct: 1,
    prior_cost_usd: 100,
    prior_total_tokens: 10_000,
    prior_message_count: 100,
    prior_session_count: 10,
    ...overrides,
  };
}

function contextRow(overrides: Partial<AgentContextHealthRow> = {}): AgentContextHealthRow {
  return {
    group_value: '',
    attention_threshold_tokens: 140_000,
    model_call_count: 10,
    prior_model_call_count: 10,
    session_count: 10,
    prior_session_count: 10,
    first_call_context_p50: 10_000,
    prior_first_call_context_p50: 10_000,
    context_p50: 20_000,
    prior_context_p50: 20_000,
    context_p90: 30_000,
    prior_context_p90: 30_000,
    context_p95: 40_000,
    prior_context_p95: 40_000,
    context_max: 50_000,
    prior_context_max: 50_000,
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
    bloated_start_25k_sessions: 0,
    prior_bloated_start_25k_sessions: 0,
    pct_bloated_start_25k: 0,
    prior_pct_bloated_start_25k: 0,
    bloated_start_50k_sessions: 0,
    prior_bloated_start_50k_sessions: 0,
    pct_bloated_start_50k: 0,
    prior_pct_bloated_start_50k: 0,
    bloated_start_100k_sessions: 0,
    prior_bloated_start_100k_sessions: 0,
    pct_bloated_start_100k: 0,
    prior_pct_bloated_start_100k: 0,
    ...overrides,
  };
}

function failure(overrides: Partial<FailureLeaderboardRow> = {}): FailureLeaderboardRow {
  return {
    tool_name: 'Bash',
    command_family: 'git commit',
    event_count: 100,
    success_count: 90,
    failure_count: 10,
    unknown_count: 0,
    failure_rate: 0.1,
    ...overrides,
  };
}

const baseArgs = {
  summary: summary(),
  contextHealth: contextRow(),
  failures: [] as FailureLeaderboardRow[],
  attentionThresholdTokens: 140_000,
  paceDeltaRatio: 0,
};

describe('buildAttentionSignals', () => {
  it('returns no signals when everything is within thresholds', () => {
    expect(buildAttentionSignals(baseArgs)).toEqual([]);
  });

  it('flags a cost spike as critical and sorts it first', () => {
    const signals = buildAttentionSignals({
      ...baseArgs,
      summary: summary({ estimated_cost_usd: 200, prior_cost_usd: 100 }),
      // also trip a warn signal to verify ordering
      paceDeltaRatio: 0.5,
    });
    expect(signals[0].id).toBe('cost-spike');
    expect(signals[0].severity).toBe('critical');
    expect(signals.some((s) => s.id === 'pace-up')).toBe(true);
    expect(signals[0].label).toContain('100%');
  });

  it('does not flag cost when the increase is under the threshold', () => {
    const signals = buildAttentionSignals({
      ...baseArgs,
      summary: summary({ estimated_cost_usd: 120, prior_cost_usd: 100 }),
    });
    expect(signals.find((s) => s.id === 'cost-spike')).toBeUndefined();
  });

  it('flags rising context bloat only when current exceeds prior', () => {
    const rising = buildAttentionSignals({
      ...baseArgs,
      contextHealth: contextRow({
        pct_sessions_over_threshold: 0.3,
        prior_pct_sessions_over_threshold: 0.1,
      }),
    });
    expect(rising.some((s) => s.id === 'context-bloat')).toBe(true);

    const falling = buildAttentionSignals({
      ...baseArgs,
      contextHealth: contextRow({
        pct_sessions_over_threshold: 0.3,
        prior_pct_sessions_over_threshold: 0.4,
      }),
    });
    expect(falling.some((s) => s.id === 'context-bloat')).toBe(false);
  });

  it('flags bloated starts above the 50K threshold ratio', () => {
    const signals = buildAttentionSignals({
      ...baseArgs,
      contextHealth: contextRow({ pct_bloated_start_50k: 0.4 }),
    });
    expect(signals.some((s) => s.id === 'bloated-starts')).toBe(true);
  });

  it('flags the worst failing tool and counts the rest', () => {
    const signals = buildAttentionSignals({
      ...baseArgs,
      failures: [
        failure({ tool_name: 'Edit', failure_rate: 0.3 }),
        failure({ tool_name: 'Bash', failure_rate: 0.5 }),
        failure({ tool_name: 'Read', failure_rate: 0.1 }),
      ],
    });
    const toolSignal = signals.find((s) => s.id === 'tool-failures');
    expect(toolSignal?.label).toContain('Bash');
    expect(toolSignal?.label).toContain('+1 more');
  });

  it('flags low pricing coverage as a warning', () => {
    const signals = buildAttentionSignals({
      ...baseArgs,
      summary: summary({ coverage_pct: 0.4 }),
    });
    expect(signals.some((s) => s.id === 'low-coverage')).toBe(true);
  });

  it('skips the pace signal when daily buckets were unavailable', () => {
    const signals = buildAttentionSignals({ ...baseArgs, paceDeltaRatio: null });
    expect(signals.some((s) => s.id === 'pace-up')).toBe(false);
  });
});
