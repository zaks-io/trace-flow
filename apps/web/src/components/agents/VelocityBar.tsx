'use client';

import { useMemo } from 'react';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { BentoCell } from './BentoCell';
import { buildDistributionBins, buildSkewSummary } from './agentSessionSizes';
import type { AgentCostDistributionRow } from './types';

/** Cost bands ramp warm so the eye lands on the costly tail; matches the histogram color. */
const BAND_COLORS = [
  'var(--color-chart-3)',
  'var(--color-chart-2)',
  'var(--color-chart-1)',
  'var(--color-chart-4)',
  'var(--color-chart-6)',
] as const;

/**
 * Q5: where do the dollars actually land? A single segmented bar of TOTAL spend across the
 * cost bands (not conversation counts — the dollars), so the concentration is unmistakable:
 * the priciest band usually owns most of the bar. The headline restates the top-10% skew.
 */
export function VelocityBar({
  row,
  windowDays,
}: {
  row: AgentCostDistributionRow | null;
  windowDays: number;
}) {
  const hasData = row != null && row.session_count > 0 && row.total_cost_usd > 0;
  const bins = useMemo(() => (row ? buildDistributionBins(row, 'cost') : []), [row]);
  const skew = useMemo(() => (row ? buildSkewSummary(row) : null), [row]);
  const totalCost = row?.total_cost_usd ?? 0;

  const segments = useMemo(
    () =>
      bins.map((bin, i) => ({
        label: bin.label,
        count: bin.count,
        costUsd: bin.total,
        share: totalCost > 0 ? bin.total / totalCost : 0,
        color: BAND_COLORS[i % BAND_COLORS.length],
      })),
    [bins, totalCost],
  );

  return (
    <BentoCell
      title="Where spend concentrates"
      hint="total cost by conversation-cost band"
      caveat={`Each segment is the share of total spend from conversations in that cost band. Cost is an estimate (lower bound), last ${windowDays} days.`}
    >
      {hasData && row && skew ? (
        <div className="flex h-full flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                {formatCurrency(totalCost)}
              </span>
              <span className="text-xs text-muted-foreground">total estimated cost</span>
            </div>
            <p className="ml-auto text-xs text-muted-foreground">
              priciest{' '}
              <span className="font-mono font-semibold tabular-nums text-amber-400">
                {formatPercent(skew.topCostShare * 100)}
              </span>{' '}
              of spend in{' '}
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {formatNumber(skew.topCount)}
              </span>{' '}
              conversations
            </p>
          </div>

          <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-muted/30">
            {segments.map((seg) =>
              seg.share > 0 ? (
                <div
                  key={seg.label}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{ width: `${seg.share * 100}%`, backgroundColor: seg.color }}
                  title={`${seg.label}: ${formatCurrency(seg.costUsd)} (${formatPercent(seg.share * 100)})`}
                />
              ) : null,
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {segments.map((seg) => (
              <BandLegend key={seg.label} seg={seg} />
            ))}
          </div>
        </div>
      ) : (
        <p className="flex h-full min-h-[120px] items-center text-sm text-muted-foreground">
          No priced conversations in this range.
        </p>
      )}
    </BentoCell>
  );
}

function BandLegend({
  seg,
}: {
  seg: { label: string; count: number; costUsd: number; share: number; color: string };
}) {
  return (
    <div className="rounded-lg bg-card/60 p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: seg.color }} />
        <span className="text-[11px] font-medium text-foreground">{seg.label}</span>
      </div>
      <div className="mt-1 flex items-baseline justify-between">
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
          {formatCurrency(seg.costUsd)}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatPercent(seg.share * 100)}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatNumber(seg.count)} conv
      </p>
    </div>
  );
}
