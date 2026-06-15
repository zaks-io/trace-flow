'use client';

import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { computeDelta } from './delta';
import type { BurnRateStats } from './burnRate';
import { StatTile } from './StatTile';
import { COST_CAVEAT } from './copy';
import type { AgentSummaryRow } from './types';

/**
 * The Overview "at a glance" strip: four headline stats (each vs prior) plus a forward-looking
 * expectation tile (projected 30-day cost + active-day pace). Answers "where is my usage" and
 * "what can I expect" in one row from data already fetched for the page. `stats` is built once by
 * the parent (it also feeds the attention pace signal) and is null when daily buckets are missing.
 */
export function OverviewGlance({
  summary,
  stats,
}: {
  summary: AgentSummaryRow;
  stats: BurnRateStats | null;
}) {
  const coverageLabel =
    summary.coverage_pct == null ? null : `${formatPercent(summary.coverage_pct * 100)} priced`;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <StatTile
        label="Estimated cost"
        value={formatCurrency(summary.estimated_cost_usd)}
        delta={computeDelta(summary.estimated_cost_usd, summary.prior_cost_usd)}
        invertDelta
        chip={coverageLabel ?? undefined}
        chipTitle={COST_CAVEAT}
      />
      <StatTile
        label="Tokens"
        value={formatNumber(summary.total_tokens)}
        delta={computeDelta(summary.total_tokens, summary.prior_total_tokens)}
      />
      <StatTile
        label="Messages"
        value={formatNumber(summary.message_count)}
        delta={computeDelta(summary.message_count, summary.prior_message_count)}
      />
      <StatTile
        label="Sessions"
        value={formatNumber(summary.session_count)}
        delta={computeDelta(summary.session_count, summary.prior_session_count)}
      />
      {stats ? (
        <StatTile
          label="Projected 30-day cost"
          value={formatCurrency(stats.projectedThirtyDayCost)}
          sub={
            <>
              at {formatCurrency(stats.costPerActiveDay)} / active day (
              {Math.round(stats.activeDays)} of {Math.round(stats.calendarDays)} days active)
            </>
          }
          delta={stats.costPerActiveDayDeltaPct}
          deltaMode="ratio"
          invertDelta
        />
      ) : (
        <StatTile
          label="Projected 30-day cost"
          value="—"
          sub="Needs daily usage buckets to project a pace"
        />
      )}
    </div>
  );
}
