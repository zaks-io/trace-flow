import { describe, expect, it } from 'vitest';
import { buildAttentionSignals } from '../buildAttentionSignals';
import type {
  AgentContextHealthRow,
  AgentNotableChangeRow,
  AgentSummaryRow,
  FailureLeaderboardRow,
} from '../types';

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
    context_p10: 5_000,
    prior_context_p10: 5_000,
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
    worst_session_pk: '',
    worst_session_context_max: 0,
    worst_session_calls_over_threshold: 0,
    ...overrides,
  };
}

function notable(overrides: Partial<AgentNotableChangeRow> = {}): AgentNotableChangeRow {
  return {
    group_value: '',
    window_days: 7,
    current_cost_usd: 70,
    prior_cost_usd: 70,
    cost_delta_usd: 0,
    current_daily_cost_usd: 10,
    baseline_daily_cost_usd: 10,
    daily_cost_vs_baseline_usd: 0,
    current_generated_tokens: 100_000,
    prior_generated_tokens: 100_000,
    generated_tokens_delta: 0,
    baseline_active_days: 14,
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
  notableTotal: notable(),
  failures: [] as FailureLeaderboardRow[],
  attentionThresholdTokens: 140_000,
};

describe('buildAttentionSignals', () => {
  it('returns no signals when everything is within thresholds', () => {
    expect(buildAttentionSignals(baseArgs)).toEqual([]);
  });

  it('flags spend pace running above the trailing-28d daily average', () => {
    const signals = buildAttentionSignals({
      ...baseArgs,
      notableTotal: notable({
        current_daily_cost_usd: 20,
        baseline_daily_cost_usd: 10,
        daily_cost_vs_baseline_usd: 10,
      }),
    });
    const pace = signals.find((s) => s.id === 'pace-vs-baseline');
    expect(pace).toBeDefined();
    expect(pace?.detail).toContain('28-day average');
  });

  it('does not flag pace when above the prior period but within the baseline ratio', () => {
    const signals = buildAttentionSignals({
      ...baseArgs,
      notableTotal: notable({
        current_daily_cost_usd: 12,
        baseline_daily_cost_usd: 10,
        daily_cost_vs_baseline_usd: 2,
      }),
    });
    expect(signals.some((s) => s.id === 'pace-vs-baseline')).toBe(false);
  });

  it('does not flag pace when the absolute daily gap is tiny', () => {
    const signals = buildAttentionSignals({
      ...baseArgs,
      notableTotal: notable({
        current_daily_cost_usd: 0.6,
        baseline_daily_cost_usd: 0.2,
        daily_cost_vs_baseline_usd: 0.4,
      }),
    });
    expect(signals.some((s) => s.id === 'pace-vs-baseline')).toBe(false);
  });

  it('flags rising per-turn context pressure only when current exceeds prior', () => {
    const rising = buildAttentionSignals({
      ...baseArgs,
      contextHealth: contextRow({
        calls_over_threshold: 30,
        pct_calls_over_threshold: 0.3,
        prior_pct_calls_over_threshold: 0.1,
      }),
    });
    const signal = rising.find((s) => s.id === 'context-pressure');
    expect(signal).toBeDefined();
    expect(signal?.label).toContain('30 turns');

    const falling = buildAttentionSignals({
      ...baseArgs,
      contextHealth: contextRow({
        pct_calls_over_threshold: 0.3,
        prior_pct_calls_over_threshold: 0.4,
      }),
    });
    expect(falling.some((s) => s.id === 'context-pressure')).toBe(false);
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

  it('skips the pace signal when notable-changes data is unavailable', () => {
    const signals = buildAttentionSignals({ ...baseArgs, notableTotal: null });
    expect(signals.some((s) => s.id === 'pace-vs-baseline')).toBe(false);
  });
});
