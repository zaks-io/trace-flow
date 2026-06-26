'use client';

import { useMemo } from 'react';
import { Area, AreaChart, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts';
import type { AnalystPageContextReference } from '@/components/analyst/pageContext';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BentoCell } from './BentoCell';
import { buildConcentrationCurve, type ConcentrationCurve } from './agentSessionSizes';
import type { AgentCostDistributionRow } from './types';

const CHART_CONFIG = {
  costPct: { label: 'Cumulative spend', color: 'var(--color-chart-1)' },
};

/**
 * Q5: how concentrated is my spend? A bin-free concentration (Lorenz) curve — cumulative share
 * of spend (y) against cumulative share of conversations (x), sorted priciest-first, so the
 * curve bows above the diagonal. The diagonal is perfectly even spend; the bulge above it is
 * concentration, and its area is the Gini coefficient. Every number here is derived from the
 * per-conversation cost array — no chosen dollar or percentile cutpoints. Expanding the cell
 * drills into the actual priciest conversations.
 */
export function VelocityBar({
  row,
  windowDays,
  expanded,
  onToggleExpand,
  expandedContent,
  contextReference,
}: {
  row: AgentCostDistributionRow | null;
  windowDays: number;
  expanded: boolean;
  onToggleExpand: () => void;
  expandedContent: React.ReactNode;
  contextReference?: AnalystPageContextReference;
}) {
  const hasData = row != null && row.session_count > 0 && row.total_cost_usd > 0;
  const curve = useMemo<ConcentrationCurve | null>(
    () => (row ? buildConcentrationCurve(row) : null),
    [row],
  );

  return (
    <BentoCell
      title="Where spend concentrates"
      hint="cumulative share of spend vs share of conversations"
      expandable
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      expandedContent={expandedContent}
      contextReference={contextReference}
      caveat={`The diagonal is perfectly even spend; the bulge above it is concentration. Conversations are sorted priciest-first. The Gini is sample-bias-corrected (n/(n-1)) so cohorts of different sizes compare fairly. Cost is an estimate (lower bound), last ${windowDays} days.`}
    >
      {hasData && curve && curve.points.length > 1 ? (
        <ConcentrationCurveView curve={curve} />
      ) : (
        <p className="flex h-full min-h-[160px] items-center text-sm text-muted-foreground">
          No priced conversations in this range.
        </p>
      )}
    </BentoCell>
  );
}

function ConcentrationCurveView({ curve }: { curve: ConcentrationCurve }) {
  // Render shares as 0–100 so the axes read as percentages.
  const data = curve.points.map((p) => ({ x: p.convPct * 100, y: p.costPct * 100 }));
  const halfShare = curve.sessionCount > 0 ? curve.halfSpendCount / curve.sessionCount : 0;
  const halfDot = pointAtConvShare(curve, halfShare);
  const topDot = pointAtConvShare(curve, 0.1);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
            {curve.gini.toFixed(2)}
          </span>
          <span className="text-xs text-muted-foreground">Gini</span>
        </div>
        <p className="text-xs text-muted-foreground">
          0 = even across all conversations, 1 = all in one
        </p>
        <p className="ml-auto text-xs text-muted-foreground">
          {formatCurrency(curve.totalCost)} across{' '}
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {formatNumber(curve.sessionCount)}
          </span>{' '}
          conversations
        </p>
      </div>

      <ChartContainer config={CHART_CONFIG} className="!aspect-auto h-[200px] w-full">
        <AreaChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id="concentration-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <XAxis
            type="number"
            dataKey="x"
            domain={[0, 100]}
            tick={{ fontSize: 10 }}
            tickFormatter={(v) => `${v}%`}
            tickMargin={6}
            label={{
              value: '% of conversations (priciest first)',
              position: 'insideBottom',
              offset: -2,
              fontSize: 10,
              fill: 'var(--color-muted-foreground)',
            }}
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[0, 100]}
            tick={{ fontSize: 10 }}
            tickFormatter={(v) => `${v}%`}
            width={36}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  `Top ${formatPercent(Number(payload?.[0]?.payload?.x ?? 0))} of conversations`
                }
                valueFormatter={(v) => `${formatPercent(Number(v))} of spend`}
              />
            }
          />
          {/* Diagonal = perfectly even spend; the gap above it is the concentration. */}
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 100, y: 100 },
            ]}
            stroke="var(--color-muted-foreground)"
            strokeDasharray="4 4"
            strokeOpacity={0.5}
            ifOverflow="extendDomain"
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke="var(--color-chart-1)"
            strokeWidth={2}
            fill="url(#concentration-fill)"
            isAnimationActive={false}
            dot={false}
          />
          {halfDot && (
            <ReferenceDot
              x={halfDot.x}
              y={halfDot.y}
              r={4}
              fill="var(--color-chart-1)"
              stroke="var(--color-background)"
              strokeWidth={1.5}
            />
          )}
          {topDot && (
            <ReferenceDot
              x={topDot.x}
              y={topDot.y}
              r={4}
              fill="#fbbf24"
              stroke="var(--color-background)"
              strokeWidth={1.5}
            />
          )}
        </AreaChart>
      </ChartContainer>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>
          Half your spend is in{' '}
          <span
            className="font-mono font-semibold tabular-nums"
            style={{ color: 'var(--color-chart-1)' }}
          >
            {formatNumber(curve.halfSpendCount)}
          </span>{' '}
          {curve.halfSpendCount === 1 ? 'conversation' : 'conversations'}
        </span>
        {curve.topCostShare > 0 && (
          <span>
            The priciest{' '}
            <span className="font-mono font-semibold tabular-nums text-amber-400">
              {formatNumber(curve.topCount)}
            </span>{' '}
            carry{' '}
            <span className="font-mono font-semibold tabular-nums text-amber-400">
              {formatPercent(curve.topCostShare * 100)}
            </span>{' '}
            of spend
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The plotted curve is downsampled, so the exact rank for a given conversation-share may not be
 * a vertex. Linear-interpolate the cost-share between the two bracketing points so the marked
 * dot sits on the drawn line. Returns null when the curve has no usable span.
 */
function pointAtConvShare(
  curve: ConcentrationCurve,
  convShare: number,
): { x: number; y: number } | null {
  const points = curve.points;
  if (points.length < 2) return null;
  const target = Math.min(1, Math.max(0, convShare));
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const next = points[i];
    if (target <= next.convPct) {
      const span = next.convPct - prev.convPct;
      const t = span > 0 ? (target - prev.convPct) / span : 0;
      const costPct = prev.costPct + t * (next.costPct - prev.costPct);
      return { x: target * 100, y: costPct * 100 };
    }
  }
  const last = points[points.length - 1];
  return { x: last.convPct * 100, y: last.costPct * 100 };
}
