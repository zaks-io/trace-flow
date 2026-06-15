import { formatNumber, formatPercent } from '@/lib/format';
import { computeDelta } from './delta';
import type { AgentContextHealthRow, AgentSummaryRow, FailureLeaderboardRow } from './types';

export type AttentionSeverity = 'critical' | 'warn';

export interface AttentionSignal {
  id: string;
  severity: AttentionSeverity;
  label: string;
  detail: string;
}

/** Thresholds for raising an attention signal. Tuned conservatively; adjust as data informs. */
const ATTENTION_THRESHOLDS = {
  costSpikePct: 30,
  paceUpRatio: 0.25,
  contextCrossRatio: 0.2,
  bloatedStartRatio: 0.25,
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
 * `paceDeltaRatio` is the cost-per-active-day change as a raw ratio (from buildBurnRateStats);
 * null when daily buckets were unavailable, in which case the pace signal is skipped.
 */
export function buildAttentionSignals({
  summary,
  contextHealth,
  failures,
  attentionThresholdTokens,
  paceDeltaRatio,
}: {
  summary: AgentSummaryRow | null;
  contextHealth: AgentContextHealthRow | null;
  failures: FailureLeaderboardRow[];
  attentionThresholdTokens: number;
  paceDeltaRatio: number | null;
}): AttentionSignal[] {
  const signals: AttentionSignal[] = [];
  const threshold = formatNumber(attentionThresholdTokens);

  if (summary) {
    const costDelta = computeDelta(summary.estimated_cost_usd, summary.prior_cost_usd);
    if (costDelta !== null && costDelta > ATTENTION_THRESHOLDS.costSpikePct) {
      signals.push({
        id: 'cost-spike',
        severity: 'critical',
        label: `Cost up ${costDelta.toFixed(0)}%`,
        detail: 'Estimated cost rose sharply versus the previous equal-length window.',
      });
    }

    if (summary.coverage_pct != null && summary.coverage_pct < ATTENTION_THRESHOLDS.coverageFloor) {
      signals.push({
        id: 'low-coverage',
        severity: 'warn',
        label: `Only ${pct(summary.coverage_pct)} of turns priced`,
        detail: 'Cost is a lower bound — many billable turns are unpriced for this range.',
      });
    }
  }

  if (paceDeltaRatio !== null && paceDeltaRatio > ATTENTION_THRESHOLDS.paceUpRatio) {
    signals.push({
      id: 'pace-up',
      severity: 'warn',
      label: `Daily spend pace up ${(paceDeltaRatio * 100).toFixed(0)}%`,
      detail: 'Cost per active day is running above the previous window.',
    });
  }

  if (contextHealth) {
    const crossing = contextHealth.pct_sessions_over_threshold;
    const priorCrossing = contextHealth.prior_pct_sessions_over_threshold;
    if (crossing > ATTENTION_THRESHOLDS.contextCrossRatio && crossing > priorCrossing) {
      signals.push({
        id: 'context-bloat',
        severity: 'warn',
        label: `${pct(crossing)} of conversations cross ${threshold} tokens`,
        detail: `Up from ${pct(priorCrossing)} in the previous window — context is growing.`,
      });
    }

    if (contextHealth.pct_bloated_start_50k > ATTENTION_THRESHOLDS.bloatedStartRatio) {
      signals.push({
        id: 'bloated-starts',
        severity: 'warn',
        label: `${pct(contextHealth.pct_bloated_start_50k)} of conversations start above 50K tokens`,
        detail: 'New conversations begin large, before any work is done.',
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
