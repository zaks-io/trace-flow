'use client';

import { useMemo } from 'react';
import { buildBurnRateStats, hasUsableBurnRateBuckets } from './burnRate';
import { buildAttentionSignals } from './buildAttentionSignals';
import { OverviewGlance } from './OverviewGlance';
import { AttentionCallout } from './AttentionCallout';
import { ContextBar } from './ContextBar';
import type {
  AgentBreakdownDimension,
  AgentContextHealthRow,
  AgentSummaryRow,
  AgentTimeseriesRow,
  FailureLeaderboardRow,
} from './types';

/**
 * The always-on Overview: answers "where is my usage" (glance + context bar), "what should I
 * worry about" (attention callout), and "what can I expect" (projection) from data already
 * fetched for the page. The deep panels live in the tabs below it.
 */
export function AgentOverview({
  summary,
  burnSeries,
  priorBurnSeries,
  contextHealth,
  failures,
  attentionThresholdTokens,
  filterParams,
  timezone = 'UTC',
  labelFor,
  selectedFor,
  onToggle,
}: {
  summary: AgentSummaryRow;
  burnSeries: AgentTimeseriesRow[];
  priorBurnSeries: AgentTimeseriesRow[];
  contextHealth: AgentContextHealthRow | null;
  failures: FailureLeaderboardRow[];
  attentionThresholdTokens: number;
  filterParams: Record<string, string | number>;
  timezone?: string;
  labelFor: (value: string) => string;
  selectedFor: (dimension: AgentBreakdownDimension) => string[];
  onToggle: (dimension: AgentBreakdownDimension, value: string) => void;
}) {
  // Burn-rate stats power both the glance projection tile and the attention pace signal; build
  // them once here and pass down. Null when daily buckets are unavailable so the glance shows its
  // fallback and the attention layer skips pace rather than inventing one.
  const stats = useMemo(
    () =>
      hasUsableBurnRateBuckets(burnSeries, timezone)
        ? buildBurnRateStats({
            summary,
            currentRows: burnSeries,
            priorRows: priorBurnSeries,
            filterParams,
            timezone,
          })
        : null,
    [summary, burnSeries, priorBurnSeries, filterParams, timezone],
  );

  const signals = useMemo(
    () =>
      buildAttentionSignals({
        summary,
        contextHealth,
        failures,
        attentionThresholdTokens,
        paceDeltaRatio: stats?.costPerActiveDayDeltaPct ?? null,
      }),
    [summary, contextHealth, failures, attentionThresholdTokens, stats],
  );

  return (
    <div className="space-y-4">
      <OverviewGlance summary={summary} stats={stats} />
      <AttentionCallout signals={signals} />
      <ContextBar
        filterParams={filterParams}
        labelFor={labelFor}
        selectedFor={selectedFor}
        onToggle={onToggle}
      />
    </div>
  );
}
