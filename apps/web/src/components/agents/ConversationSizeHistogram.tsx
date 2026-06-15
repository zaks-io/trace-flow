'use client';

import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BentoCell } from './BentoCell';
import {
  axisLabel,
  buildDistributionBins,
  buildPercentiles,
  buildSkewSummary,
  formatAxisValue,
  type DistributionAxis,
} from './agentSessionSizes';
import type { AgentCostDistributionRow } from './types';

const CHART_CONFIG = {
  count: { label: 'Conversations', color: 'var(--color-chart-1)' },
};

/**
 * Q4: where does the spend go? A histogram of conversations by COST (default) or generated
 * tokens (toggle) — never by message count, which hides the dollars. The headline is the
 * skew: a handful of conversations carry most of the cost. Per-conversation p50/p95 and the
 * top-10% concentration make that explicit.
 */
export function ConversationSizeHistogram({
  row,
  windowDays,
  expanded,
  onToggleExpand,
}: {
  row: AgentCostDistributionRow | null;
  windowDays: number;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const [axis, setAxis] = useState<DistributionAxis>('cost');
  const hasData = row != null && row.session_count > 0;

  const bins = useMemo(() => (row ? buildDistributionBins(row, axis) : []), [row, axis]);
  const percentiles = useMemo(() => (row ? buildPercentiles(row, axis) : null), [row, axis]);
  const skew = useMemo(() => (row ? buildSkewSummary(row) : null), [row]);

  const fmt = (v: number) => formatAxisValue(axis, v);
  const maxCount = bins.reduce((m, b) => Math.max(m, b.count), 0);

  return (
    <BentoCell
      title="Cost per conversation"
      hint={axis === 'cost' ? 'conversations by spend' : 'conversations by tokens generated'}
      expandable
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      toolbar={<AxisToggle axis={axis} onChange={setAxis} />}
      caveat={
        axis === 'cost'
          ? `Cost is an estimate (lower bound). Distribution over the last ${windowDays} days.`
          : `Generated tokens (input + output + reasoning), excludes cache read. Last ${windowDays} days.`
      }
      expandedContent={
        hasData && row && percentiles ? (
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <Stat label="p50 / conversation" value={fmt(percentiles.p50)} />
            <Stat label="p90 / conversation" value={fmt(percentiles.p90)} />
            <Stat label="p95 / conversation" value={fmt(percentiles.p95)} />
            <Stat label="most expensive" value={fmt(percentiles.max)} />
          </dl>
        ) : null
      }
    >
      {hasData && row && percentiles && skew ? (
        <div className="flex h-full flex-col">
          <SkewHeadline axis={axis} percentiles={percentiles} skew={skew} windowDays={windowDays} />

          <ChartContainer config={CHART_CONFIG} className="mt-3 !aspect-auto h-[140px] w-full">
            <BarChart data={bins} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} tickMargin={6} />
              <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    valueFormatter={(v) => `${formatNumber(Number(v))} conversations`}
                  />
                }
              />
              <Bar dataKey="count" radius={2}>
                {bins.map((entry, i) => (
                  <Cell
                    key={entry.label}
                    fill="var(--color-chart-1)"
                    fillOpacity={maxCount > 0 ? 0.35 + 0.65 * (entry.count / maxCount) : 0.5}
                    // Last band is the costly tail — flag it so the eye lands there.
                    stroke={
                      i === bins.length - 1 && entry.count > 0 ? 'var(--color-chart-1)' : undefined
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>
      ) : (
        <p className="flex h-[180px] items-center text-sm text-muted-foreground">
          No conversations in this range.
        </p>
      )}
    </BentoCell>
  );
}

function SkewHeadline({
  axis,
  percentiles,
  skew,
  windowDays,
}: {
  axis: DistributionAxis;
  percentiles: { p50: number; p95: number; priorP50: number };
  skew: { topCount: number; topCostUsd: number; topCostShare: number };
  windowDays: number;
}) {
  const fmt = (v: number) => formatAxisValue(axis, v);
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
      <Headline label={`median ${axisLabel(axis).toLowerCase()}`} value={fmt(percentiles.p50)} />
      <Headline label="p95" value={fmt(percentiles.p95)} />
      {skew.topCostShare > 0 && (
        <p className="ml-auto text-xs text-muted-foreground">
          top{' '}
          <span className="font-mono font-semibold tabular-nums text-amber-400">
            {formatNumber(skew.topCount)}
          </span>{' '}
          conversations ={' '}
          <span className="font-mono font-semibold tabular-nums text-amber-400">
            {formatPercent(skew.topCostShare * 100)}
          </span>{' '}
          of spend ({formatCurrency(skew.topCostUsd)})
        </p>
      )}
      <span className="sr-only">over the last {windowDays} days</span>
    </div>
  );
}

function AxisToggle({
  axis,
  onChange,
}: {
  axis: DistributionAxis;
  onChange: (next: DistributionAxis) => void;
}) {
  const options: DistributionAxis[] = ['cost', 'tokens'];
  return (
    <div className="flex rounded-lg border border-border/60">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            'px-2 py-1 text-[11px] font-medium transition-colors first:rounded-l-lg last:rounded-r-lg',
            axis === option
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option === 'cost' ? 'Cost' : 'Tokens'}
        </button>
      ))}
    </div>
  );
}

function Headline({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-mono text-xl font-semibold tabular-nums text-foreground">{value}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-card/60 p-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}
