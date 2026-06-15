import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import type {
  AgentContextHealthRow,
  AgentNotableChangeRow,
  AgentSummaryRow,
  FailureLeaderboardRow,
} from './types';

export type AttentionSeverity = 'critical' | 'warn';

export interface AttentionSignal {
  id: string;
  severity: AttentionSeverity;
  label: string;
  detail: string;
}

/**
 * Thresholds for raising a signal. These gate facts worth surfacing; the copy never claims a
 * value is "unusual" or an "anomaly" — it states the fact and lets the reader judge.
 */
const ATTENTION_THRESHOLDS = {
  /** Current daily pace must beat the trailing-28d daily average by this multiple to surface. */
  paceVsBaselineRatio: 1.5,
  /** ...and exceed this absolute daily dollar gap, so tiny baselines don't trip it. */
  paceVsBaselineMinUsd: 1,
  contextCrossRatio: 0.2,
  toolFailureRate: 0.25,
  coverageFloor: 0.6,
} as const;

function pct(ratio: number): string {
  return formatPercent(ratio * 100);
}

/**
 * Derive the "what should I worry about" signals from data already fetched for the page —
 * no extra queries. Returns critical-first; an empty array means nothing crossed a threshold.
 *
 * The spend-pace signal compares the window's daily pace against a trailing-28-day daily
 * average (from `agent_notable_changes`), NOT a single prior equal-length window — a longer
 * norm, so a busy day after a quiet one isn't mislabeled. Context pressure is counted at the
 * per-turn grain (turns over the threshold), not whole conversations.
 */
export function buildAttentionSignals({
  summary,
  contextHealth,
  notableTotal,
  failures,
  attentionThresholdTokens,
}: {
  summary: AgentSummaryRow | null;
  contextHealth: AgentContextHealthRow | null;
  notableTotal: AgentNotableChangeRow | null;
  failures: FailureLeaderboardRow[];
  attentionThresholdTokens: number;
}): AttentionSignal[] {
  const signals: AttentionSignal[] = [];
  const threshold = formatNumber(attentionThresholdTokens);

  if (summary?.coverage_pct != null && summary.coverage_pct < ATTENTION_THRESHOLDS.coverageFloor) {
    signals.push({
      id: 'low-coverage',
      severity: 'warn',
      label: `Only ${pct(summary.coverage_pct)} of turns priced`,
      detail: 'Cost is a lower bound — many billable turns are unpriced for this range.',
    });
  }

  if (notableTotal) {
    const { current_daily_cost_usd, baseline_daily_cost_usd, daily_cost_vs_baseline_usd } =
      notableTotal;
    const exceedsRatio =
      baseline_daily_cost_usd > 0 &&
      current_daily_cost_usd >= baseline_daily_cost_usd * ATTENTION_THRESHOLDS.paceVsBaselineRatio;
    if (exceedsRatio && daily_cost_vs_baseline_usd >= ATTENTION_THRESHOLDS.paceVsBaselineMinUsd) {
      signals.push({
        id: 'pace-vs-baseline',
        severity: 'warn',
        label: `Daily spend ${formatCurrency(current_daily_cost_usd)}/day, above the 28-day average`,
        detail: `Trailing 28-day average is ${formatCurrency(baseline_daily_cost_usd)}/day (${formatNumber(notableTotal.baseline_active_days)} active days).`,
      });
    }
  }

  if (contextHealth) {
    const crossing = contextHealth.pct_calls_over_threshold;
    const priorCrossing = contextHealth.prior_pct_calls_over_threshold;
    if (crossing > ATTENTION_THRESHOLDS.contextCrossRatio && crossing > priorCrossing) {
      signals.push({
        id: 'context-pressure',
        severity: 'warn',
        label: `${formatNumber(contextHealth.calls_over_threshold)} turns over ${threshold} tokens (${pct(crossing)})`,
        detail: `Up from ${pct(priorCrossing)} of turns in the previous window.`,
      });
    }
  }

  const failing = failures
    .filter(
      (row) => row.failure_rate != null && row.failure_rate >= ATTENTION_THRESHOLDS.toolFailureRate,
    )
    .sort((a, b) => (b.failure_rate ?? 0) - (a.failure_rate ?? 0));
  if (failing.length > 0) {
    const worst = failing[0];
    const more = failing.length - 1;
    signals.push({
      id: 'tool-failures',
      severity: 'warn',
      label: `${worst.tool_name} failing ${pct(worst.failure_rate ?? 0)} of calls${more > 0 ? ` (+${more} more)` : ''}`,
      detail: 'One or more tools are failing at a high rate in this window.',
    });
  }

  return signals.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function severityRank(severity: AttentionSeverity): number {
  return severity === 'critical' ? 0 : 1;
}
