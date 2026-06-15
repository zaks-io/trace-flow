'use client';

import { useMemo } from 'react';
import { Bar, BarChart, Cell, ReferenceLine, XAxis, YAxis } from 'recharts';
import { formatNumber } from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BentoCell } from './BentoCell';
import { computeDelta } from './delta';
import { DeltaBadge } from './DeltaBadge';
import { buildContextBins } from './contextDistribution';
import type { AgentContextHealthRow } from './types';

const CHART_CONFIG = {
  count: { label: 'Turns', color: 'var(--color-chart-1)' },
};

/**
 * Where does my per-turn context actually sit? A histogram of every measured assistant turn
 * by context size (input + cache read + cache write), so the shape itself shows whether the
 * mass stays low or drifts into an expensive right tail. Median and p95 are the headline; the
 * threshold is only a faint marker for orientation — no number derives from it.
 */
export function ContextDistributionCell({
  row,
  windowDays,
}: {
  row: AgentContextHealthRow | null;
  windowDays: number;
}) {
  const hasData = row != null && row.model_call_count > 0;
  const threshold = row?.attention_threshold_tokens ?? 140_000;

  const medianDelta = row ? computeDelta(row.context_p50, row.prior_context_p50) : null;
  const bins = useMemo(() => (row ? buildContextBins(row) : []), [row]);
  const maxCount = bins.reduce((m, b) => Math.max(m, b.count), 0);

  return (
    <BentoCell
      title="Per-turn context size"
      hint="where your turns sit on the context window"
      caveat={`Per-turn context = input + cache read + cache write. The ${formatNumber(
        threshold,
      )} marker is a rough accuracy guide, not a limit. Last ${windowDays} days.`}
    >
      {hasData && row ? (
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <Headline label="median" value={formatNumber(row.context_p50)} />
            <Headline label="p95" value={formatNumber(row.context_p95)} />
            <DeltaBadge
              value={medianDelta}
              mode="percent"
              invert
              suffix={`median vs previous ${windowDays} days`}
              className="ml-auto"
            />
          </div>

          <ChartContainer config={CHART_CONFIG} className="mt-3 !aspect-auto h-[150px] w-full">
            <BarChart data={bins} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 10 }} tickMargin={6} interval={0} />
              <YAxis tick={{ fontSize: 10 }} width={28} allowDecimals={false} />
              <ChartTooltip
                content={
                  <ChartTooltipContent valueFormatter={(v) => `${formatNumber(Number(v))} turns`} />
                }
              />
              {/* Faint accuracy-guide marker — orientation only, drawn between the 100K/200K bars. */}
              <ReferenceLine
                x={markerLabel(threshold)}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="3 3"
                strokeOpacity={0.6}
                label={{
                  value: `${formatNumber(threshold)} guide`,
                  position: 'top',
                  fontSize: 9,
                  fill: 'var(--color-muted-foreground)',
                }}
              />
              <Bar dataKey="count" radius={2}>
                {bins.map((entry) => (
                  <Cell
                    key={entry.label}
                    fill="var(--color-chart-1)"
                    fillOpacity={maxCount > 0 ? 0.35 + 0.65 * (entry.count / maxCount) : 0.5}
                    // Warm the high-context tail so a fat right side reads as expensive.
                    stroke={
                      entry.start >= 300_000 && entry.count > 0 ? 'var(--color-chart-1)' : undefined
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>

          {row.worst_session_context_max > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Heaviest conversation peaked at{' '}
              <span className="font-mono font-semibold tabular-nums text-amber-400">
                {formatNumber(row.worst_session_context_max)}
              </span>{' '}
              tokens
              {row.worst_session_calls_over_threshold > 0 && (
                <>
                  {' '}
                  across{' '}
                  <span className="font-mono font-semibold tabular-nums text-foreground">
                    {formatNumber(row.worst_session_calls_over_threshold)}
                  </span>{' '}
                  high-context turns
                </>
              )}
              .
            </p>
          )}
        </div>
      ) : (
        <p className="flex h-full min-h-[180px] items-center text-sm text-muted-foreground">
          No measured turns in this range.
        </p>
      )}
    </BentoCell>
  );
}

/**
 * Recharts pins a category `ReferenceLine` to a bar's center, so snap the marker to the bin
 * whose lower edge the threshold falls in — close enough for a rough orientation guide.
 */
function markerLabel(threshold: number): string {
  const index = Math.min(9, Math.floor(threshold / 100_000));
  const startK = index * 100;
  if (index === 9) return `${startK}K+`;
  return startK === 0 ? '0' : `${startK}K`;
}

function Headline({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">{value}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
