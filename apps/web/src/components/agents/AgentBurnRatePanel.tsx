'use client';

import { Activity } from 'lucide-react';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { AgentSection } from './AgentSection';
import { buildBurnRateStats, hasUsableBurnRateBuckets } from './burnRate';
import type { AgentSummaryRow, AgentTimeseriesRow } from './types';

function formatSignedPercent(value: number | null): string {
  if (value === null) return 'no prior baseline';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatPercent(value * 100)}`;
}

function MetricAnswer({
  question,
  value,
  detail,
  comparison,
}: {
  question: string;
  value: string;
  detail: string;
  comparison?: string;
}) {
  return (
    <div className="min-w-0 py-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {question}
      </p>
      <p className="mt-1 break-words font-mono text-lg font-semibold leading-tight tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      {comparison && <p className="mt-1 text-xs text-muted-foreground">{comparison}</p>}
    </div>
  );
}

function hasWindowUsage(summary: AgentSummaryRow): boolean {
  return (
    summary.estimated_cost_usd > 0 ||
    summary.total_tokens > 0 ||
    summary.message_count > 0 ||
    summary.session_count > 0
  );
}

function hasPriorWindowUsage(summary: AgentSummaryRow): boolean {
  return (
    summary.prior_cost_usd > 0 ||
    summary.prior_total_tokens > 0 ||
    summary.prior_message_count > 0 ||
    summary.prior_session_count > 0
  );
}

export function AgentBurnRatePanel({
  summary,
  currentRows,
  priorRows,
  currentError,
  priorError,
  filterParams,
  timezone = 'UTC',
}: {
  summary: AgentSummaryRow | null;
  currentRows: AgentTimeseriesRow[];
  priorRows: AgentTimeseriesRow[];
  currentError?: Error | null;
  priorError?: Error | null;
  filterParams: Record<string, string | number>;
  timezone?: string;
}) {
  if (!summary) return null;

  const currentBucketsUnavailable =
    hasWindowUsage(summary) && !hasUsableBurnRateBuckets(currentRows, timezone);

  if (currentError || currentBucketsUnavailable) {
    return (
      <AgentSection
        icon={Activity}
        title="Burn Rate"
        subtitle="Current selected window compared with the previous equal-length window."
        count={0}
        countLabel="active days loaded"
      >
        <div className="grid gap-x-8 gap-y-3 border-y border-border py-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricAnswer
            question="How fast am I spending?"
            value="Could not load"
            detail="Daily usage buckets are required for active-day cost."
          />
          <MetricAnswer
            question="How many tokens am I using?"
            value="Could not load"
            detail="Daily usage buckets are required for active-day tokens."
          />
          <MetricAnswer
            question="Is this higher than normal?"
            value="Could not load"
            detail="Prior comparison needs loaded daily usage buckets."
          />
          <MetricAnswer
            question="What should I expect?"
            value={formatCurrency(summary.estimated_cost_usd)}
            detail="window total loaded; daily projection is unavailable"
          />
        </div>

        <div className="grid gap-x-8 gap-y-3 pt-3 sm:grid-cols-3">
          <MetricAnswer
            question="Are quiet days skewing this?"
            value="Could not load"
            detail="Quiet-day math needs daily usage buckets."
          />
          <MetricAnswer
            question="What about weekdays?"
            value="Could not load"
            detail="Weekday math needs daily usage buckets."
          />
          <MetricAnswer
            question="How fast am I moving?"
            value="Could not load"
            detail={`${formatNumber(summary.session_count)} conversations loaded for the window`}
          />
        </div>
      </AgentSection>
    );
  }

  const stats = buildBurnRateStats({ summary, currentRows, priorRows, filterParams, timezone });
  const priorBucketsUnavailable =
    hasPriorWindowUsage(summary) && !hasUsableBurnRateBuckets(priorRows, timezone);
  const priorComparisonUnavailable = priorError || priorBucketsUnavailable;
  const priorCostComparison = priorComparisonUnavailable
    ? 'Prior active-day pace: not loaded'
    : `Prior active-day pace: ${formatCurrency(stats.priorCostPerActiveDay)} / day`;
  const priorTokenComparison = priorComparisonUnavailable
    ? 'Prior active-day pace: not loaded'
    : `Prior active-day pace: ${formatNumber(stats.priorTokensPerActiveDay)} tokens / day`;
  const costDelta = priorComparisonUnavailable
    ? 'prior baseline not loaded'
    : formatSignedPercent(stats.costPerActiveDayDeltaPct);
  const tokenDelta = priorComparisonUnavailable
    ? 'Tokens per active day: prior baseline not loaded'
    : `Tokens per active day: ${formatSignedPercent(stats.tokenPerActiveDayDeltaPct)}`;
  const projectedComparison = priorComparisonUnavailable
    ? 'Prior pace projected: not loaded'
    : `Prior pace projected: ${formatCurrency(stats.priorProjectedThirtyDayCost)}`;

  return (
    <AgentSection
      icon={Activity}
      title="Burn Rate"
      subtitle="Current selected window compared with the previous equal-length window."
      count={Math.round(stats.activeDays)}
      countLabel={`active days of ${formatNumber(Math.round(stats.calendarDays))}`}
    >
      <div className="grid gap-x-8 gap-y-3 border-y border-border py-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricAnswer
          question="How fast am I spending?"
          value={`${formatCurrency(stats.costPerActiveDay)} / active day`}
          detail={`${formatCurrency(stats.costPerCalendarDay)} / calendar day`}
          comparison={priorCostComparison}
        />
        <MetricAnswer
          question="How many tokens am I using?"
          value={`${formatNumber(stats.tokensPerActiveDay)} tokens / active day`}
          detail={`${formatNumber(stats.messagesPerActiveDay)} assistant calls / active day`}
          comparison={priorTokenComparison}
        />
        <MetricAnswer
          question="Is this higher than normal?"
          value={costDelta}
          detail="cost per active day vs previous equal window"
          comparison={tokenDelta}
        />
        <MetricAnswer
          question="What should I expect?"
          value={formatCurrency(stats.projectedThirtyDayCost)}
          detail="projected 30-day cost at current calendar-day pace"
          comparison={projectedComparison}
        />
      </div>

      <div className="grid gap-x-8 gap-y-3 pt-3 sm:grid-cols-3">
        <MetricAnswer
          question="Are quiet days skewing this?"
          value={`${formatNumber(stats.quietDays)} quiet days excluded`}
          detail={`Active-day averages use ${formatNumber(stats.activeDays)} days with usage`}
        />
        <MetricAnswer
          question="What about weekdays?"
          value={
            stats.weekdayActiveDays > 0
              ? `${formatCurrency(stats.costPerWeekdayActiveDay)} / active weekday`
              : 'No active weekdays'
          }
          detail={
            stats.weekdayActiveDays > 0
              ? `${formatNumber(stats.weekdayActiveDays)} weekdays had usage`
              : 'Weekday average is unavailable for this range'
          }
        />
        <MetricAnswer
          question="How fast am I moving?"
          value={`${formatNumber(stats.sessionsPerActiveDay)} conversations / active day`}
          detail={`${formatNumber(summary.session_count)} conversations in this window`}
        />
      </div>
    </AgentSection>
  );
}
