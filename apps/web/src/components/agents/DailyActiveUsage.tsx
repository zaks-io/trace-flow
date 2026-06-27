'use client';

import { useMemo } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import type { AnalystPageContextReference } from '@/components/analyst/pageContext';
import { formatCurrency, formatNumber, parseTinybirdDate } from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BentoCell } from './BentoCell';
import { DeltaBadge } from './DeltaBadge';
import type { BurnRateStats } from './burnRate';
import type { AgentTimeseriesRow } from './types';

interface DayPoint {
  /** ISO date (YYYY-MM-DD); the day bucket key. */
  label: string;
  tokens: number;
  cost: number;
}

/**
 * Per-day (NON-cumulative) totals from the daily burn series. Unlike the cost hero, which plots
 * a cumulative run-rate, this is "what did each day cost / process on its own".
 */
function buildDays(burnSeries: AgentTimeseriesRow[]): DayPoint[] {
  const byDay = new Map<string, DayPoint>();
  for (const row of burnSeries) {
    const label = parseTinybirdDate(row.bucket_start).toISOString().slice(0, 10);
    const point = byDay.get(label) ?? { label, tokens: 0, cost: 0 };
    point.tokens += row.total_tokens;
    point.cost += row.cost_usd;
    byDay.set(label, point);
  }
  return [...byDay.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const CHART_CONFIG = {
  tokens: { label: 'Tokens', color: 'var(--color-chart-2)' },
  cost: { label: 'Cost (est.)', color: 'var(--color-chart-1)' },
};

/**
 * A daily-rhythm view: how many tokens and how much (estimated) money each active day used,
 * with the active-day averages and their vs-prior change. Built entirely from the daily burn
 * series and {@link BurnRateStats} the grid already computes.
 */
export function DailyActiveUsage({
  burnSeries,
  stats,
  contextReference,
}: {
  burnSeries: AgentTimeseriesRow[];
  /** null until daily buckets exist; the headline averages and deltas come from here. */
  stats: BurnRateStats | null;
  contextReference?: AnalystPageContextReference;
}) {
  const days = useMemo(() => buildDays(burnSeries), [burnSeries]);

  return (
    <BentoCell
      title="Daily active usage"
      hint="per active day"
      caveat="Bars and rates count only days with activity (idle days excluded). Cost is an estimate (lower bound)."
      contextReference={contextReference}
    >
      <div className="flex flex-col">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Tokens / active day
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
              {stats ? formatNumber(Math.round(stats.tokensPerActiveDay)) : '—'}
            </p>
            {stats && (
              <div className="mt-1">
                <DeltaBadge value={stats.tokenPerActiveDayDeltaPct} mode="ratio" invert />
              </div>
            )}
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              $ / active day
            </p>
            <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
              {stats ? formatCurrency(stats.costPerActiveDay) : '—'}
            </p>
            {stats && (
              <div className="mt-1">
                <DeltaBadge value={stats.costPerActiveDayDeltaPct} mode="ratio" invert />
              </div>
            )}
          </div>
        </div>

        <div className="mt-4">
          {days.length > 0 ? (
            <ChartContainer config={CHART_CONFIG} className="!aspect-auto h-[200px] w-full">
              <ComposedChart data={days} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  tickMargin={8}
                  minTickGap={32}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  yAxisId="tokens"
                  tick={{ fontSize: 10 }}
                  width={48}
                  tickFormatter={(v: number) => formatNumber(v)}
                />
                <YAxis
                  yAxisId="cost"
                  orientation="right"
                  tick={{ fontSize: 10 }}
                  width={48}
                  tickFormatter={(v: number) => formatCurrency(v)}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label: string) => label}
                      valueFormatter={(value, name) =>
                        name === 'cost'
                          ? formatCurrency(Number(value))
                          : formatNumber(Number(value))
                      }
                    />
                  }
                />
                <Bar
                  yAxisId="tokens"
                  dataKey="tokens"
                  name="tokens"
                  fill="var(--color-chart-2)"
                  fillOpacity={0.55}
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="cost"
                  dataKey="cost"
                  name="cost"
                  stroke="var(--color-chart-1)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ChartContainer>
          ) : (
            <p className="flex h-[200px] items-center text-sm text-muted-foreground">
              No daily activity in this range.
            </p>
          )}
        </div>
      </div>
    </BentoCell>
  );
}
