'use client';

import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from 'recharts';
import { formatCurrency, formatPercent, parseTinybirdDate } from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { computeDelta } from './delta';
import { DeltaBadge } from './DeltaBadge';
import type { BurnRateStats } from './burnRate';
import type { AgentSummaryRow, AgentTimeseriesRow } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROJECTION_DAYS = 30;

interface HeroPoint {
  day: number;
  label: string;
  actual: number | null;
  /** Naive run-rate trend; the dashed line that continues past the last actual day. */
  trend: number | null;
  /** Low/high projection band (calendar-day pace .. active-day pace). */
  bandLow: number | null;
  bandHigh: number | null;
}

/** Cumulative daily cost up to the latest bucket, then a linear run-rate cone to 30 days. */
function buildSeries(
  burnSeries: AgentTimeseriesRow[],
  stats: BurnRateStats | null,
): { points: HeroPoint[]; lastActualDay: number } {
  const byDay = new Map<string, number>();
  for (const row of burnSeries) {
    const key = parseTinybirdDate(row.bucket_start).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + row.cost_usd);
  }
  const days = [...byDay.keys()].sort();
  if (days.length === 0) return { points: [], lastActualDay: 0 };

  const points: HeroPoint[] = [];
  let cumulative = 0;
  days.forEach((key, i) => {
    cumulative += byDay.get(key) ?? 0;
    points.push({
      day: i,
      label: key,
      actual: cumulative,
      trend: cumulative,
      bandLow: null,
      bandHigh: null,
    });
  });

  const lastActualDay = days.length - 1;
  if (!stats) return { points, lastActualDay };

  // Project forward at the calendar-day pace (low) and active-day pace (high). Honest naive
  // linear extrapolation: no model, just "if the last window's pace held".
  const perCalendarDay = stats.costPerCalendarDay;
  const perActiveDay = Math.max(perCalendarDay, stats.costPerActiveDay);
  const startCumulative = cumulative;
  const lastDate = parseTinybirdDate(`${days[lastActualDay]}T00:00:00Z`).getTime();
  for (let step = 1; step <= PROJECTION_DAYS; step++) {
    const date = new Date(lastDate + step * DAY_MS).toISOString().slice(0, 10);
    points.push({
      day: lastActualDay + step,
      label: date,
      actual: null,
      trend: startCumulative + perCalendarDay * step,
      bandLow: startCumulative + perCalendarDay * step,
      bandHigh: startCumulative + perActiveDay * step,
    });
  }
  return { points, lastActualDay };
}

const CHART_CONFIG = {
  actual: { label: 'Cost (est.)', color: 'var(--color-chart-1)' },
  trend: { label: 'Projected', color: 'var(--color-chart-1)' },
};

export function CostProjectionHero({
  summary,
  burnSeries,
  stats,
  windowDays,
}: {
  summary: AgentSummaryRow;
  burnSeries: AgentTimeseriesRow[];
  stats: BurnRateStats | null;
  windowDays: number;
}) {
  const { points, lastActualDay } = useMemo(
    () => buildSeries(burnSeries, stats),
    [burnSeries, stats],
  );

  const costDelta = computeDelta(summary.estimated_cost_usd, summary.prior_cost_usd);
  const coverage = summary.coverage_pct == null ? null : formatPercent(summary.coverage_pct * 100);
  const projected = stats?.projectedThirtyDayCost ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Cost (est.)
          </p>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="font-mono text-4xl font-semibold tabular-nums text-foreground">
              {formatCurrency(summary.estimated_cost_usd)}
            </span>
            <DeltaBadge
              value={costDelta}
              mode="percent"
              invert
              suffix={`vs previous ${windowDays} days`}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {coverage ? `lower bound — ${coverage} of turns priced` : 'lower bound'}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Projected monthly cost
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
            {projected != null ? formatCurrency(projected) : '—'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {projected != null ? 'naive run-rate, 30 days' : 'needs daily buckets'}
          </p>
        </div>
      </div>

      <div className="mt-3 min-h-0 flex-1">
        {points.length > 0 ? (
          <ChartContainer
            config={CHART_CONFIG}
            className="!aspect-auto h-full min-h-[200px] w-full"
          >
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                tickMargin={8}
                minTickGap={48}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                width={52}
                tickFormatter={(v: number) => formatCurrency(v)}
              />
              <ChartTooltip
                content={<ChartTooltipContent valueFormatter={(v) => formatCurrency(Number(v))} />}
              />
              <Area
                dataKey="bandHigh"
                stroke="none"
                fill="var(--color-chart-1)"
                fillOpacity={0.08}
                isAnimationActive={false}
                connectNulls
              />
              <Area
                dataKey="bandLow"
                stroke="none"
                fill="var(--color-card)"
                fillOpacity={1}
                isAnimationActive={false}
                connectNulls
              />
              <Area
                dataKey="actual"
                stroke="var(--color-chart-1)"
                strokeWidth={2}
                fill="var(--color-chart-1)"
                fillOpacity={0.18}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Line
                dataKey="trend"
                stroke="var(--color-chart-1)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
              <ReferenceLine
                x={points[lastActualDay]?.label}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="2 4"
                strokeOpacity={0.5}
              />
            </ComposedChart>
          </ChartContainer>
        ) : (
          <p className="flex h-full items-center text-sm text-muted-foreground">
            No daily cost in this range.
          </p>
        )}
      </div>
    </div>
  );
}
