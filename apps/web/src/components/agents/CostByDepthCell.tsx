'use client';

import { useMemo } from 'react';
import { Area, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import { formatCurrency, formatNumber } from '@/lib/format';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';
import { BentoCell } from './BentoCell';
import {
  buildDepthSeries,
  classifyElasticity,
  elasticityGloss,
  type DepthPoint,
} from './costByDepth';
import type { AgentCostByDepthRow } from './types';

const VERDICT_COLOR = {
  declining: 'var(--color-chart-3)',
  flat: 'var(--color-chart-3)',
  linear: 'var(--color-chart-1)',
  accelerating: '#fbbf24',
} as const;

const CHART_CONFIG = {
  p50: { label: 'Median', color: 'var(--color-chart-1)' },
};

/**
 * Q: do my conversations get more expensive as they run, and is it gradual creep or a few big
 * turns? Two stacked depth charts over raw conversation depth (turn_index): per-turn CONTEXT
 * (the cause) above per-turn COST (the effect). Each shows the median line, a p25–p75 band, and a
 * faint p95 envelope — a population view, every turn at a depth across every conversation, no single
 * conversation and no chosen "deep" cutoff. The headline is a log-log elasticity (robust Theil-Sen slope):
 * ~1 is linear bloat, >1 is the runaway. Every number is derived from the per-turn facts.
 */
export function CostByDepthCell({
  rows,
  windowDays,
}: {
  rows: AgentCostByDepthRow[];
  windowDays: number;
}) {
  const series = useMemo(() => buildDepthSeries(rows), [rows]);
  const hasData = series != null && series.points.length > 1;

  return (
    <BentoCell
      title="Cost as conversations deepen"
      hint="per-turn cost & context by how deep into the conversation a turn is"
      caveat={`Each point pools every turn at that depth across all conversations — not one conversation. Depth is the raw turn position; the elasticity is a robust Theil-Sen log-log slope, not a chosen cutoff. It is an association, not causation — pooled across models and repos, so it is not controlled for which model runs at which depth. Cost is an estimate (lower bound), last ${windowDays} days.`}
    >
      {hasData && series ? (
        <div className="flex h-full flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <ElasticityHeadline
              label="cost vs depth"
              elasticity={series.costElasticity}
              doublingFactor={series.costDoublingFactor}
              fitPoints={series.costFitPoints}
            />
            <ElasticityHeadline
              label="context vs depth"
              elasticity={series.contextElasticity}
              doublingFactor={series.contextDoublingFactor}
              fitPoints={series.contextFitPoints}
            />
          </div>

          <DepthChart
            heading="Context per turn (the cause)"
            points={series.points}
            band={CONTEXT_ACCESSORS}
            valueFormatter={(v) => `${formatNumber(v)} tok`}
          />
          <DepthChart
            heading="Cost per turn (the effect)"
            points={series.points}
            band={COST_ACCESSORS}
            valueFormatter={(v) => formatCurrency(v)}
          />

          <p className="text-[11px] text-muted-foreground">
            Charted to turn{' '}
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {formatNumber(series.chartedMaxDepth)}
            </span>{' '}
            — the deepest turn reached by at least {formatNumber(series.minDepthSamples)}{' '}
            conversations. The band is p25–p75 of each turn; the faint line is p95.
            {series.pooledDepthCount > 0 && (
              <>
                {' '}
                {formatNumber(series.pooledTurnCount)} deeper{' '}
                {series.pooledTurnCount === 1 ? 'turn' : 'turns'} (out to turn{' '}
                {formatNumber(series.observedMaxDepth)}) were seen in fewer than{' '}
                {formatNumber(series.minDepthSamples)} conversations — too sparse to chart.
              </>
            )}
          </p>
        </div>
      ) : (
        <p className="flex h-full min-h-[180px] items-center text-sm text-muted-foreground">
          Not enough turns to chart depth yet.
        </p>
      )}
    </BentoCell>
  );
}

function ElasticityHeadline({
  label,
  elasticity,
  doublingFactor,
  fitPoints,
}: {
  label: string;
  elasticity: number;
  doublingFactor: number;
  fitPoints: number;
}) {
  // Under two fit points there was no trend to estimate; show that honestly instead of a fake 0.
  if (fitPoints < 2) {
    return (
      <div>
        <div className="font-mono text-2xl font-semibold tabular-nums text-muted-foreground">—</div>
        <p className="text-xs text-muted-foreground">{label}: too few depths to fit a slope</p>
      </div>
    );
  }
  const verdict = classifyElasticity(elasticity);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5">
        <span
          className="font-mono text-3xl font-semibold tabular-nums"
          style={{ color: VERDICT_COLOR[verdict] }}
        >
          {elasticity.toFixed(2)}
        </span>
        <span className="text-xs text-muted-foreground">{label} slope</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        each doubling of depth ×
        <span className="font-mono font-semibold tabular-nums text-foreground">
          {doublingFactor.toFixed(2)}
        </span>{' '}
        — {elasticityGloss(elasticity)}
      </p>
    </div>
  );
}

interface BandAccessors {
  p25: keyof DepthPoint;
  band: keyof DepthPoint;
  p50: keyof DepthPoint;
  p75: keyof DepthPoint;
  p95: keyof DepthPoint;
}

const COST_ACCESSORS: BandAccessors = {
  p25: 'costP25',
  band: 'costBand',
  p50: 'costP50',
  p75: 'costP75',
  p95: 'costP95',
};

const CONTEXT_ACCESSORS: BandAccessors = {
  p25: 'contextP25',
  band: 'contextBand',
  p50: 'contextP50',
  p75: 'contextP75',
  p95: 'contextP95',
};

/**
 * One depth chart: x = raw conversation depth, y = a per-turn quantity. The p25→p75 band is a
 * transparent base (`p25`) plus a translucent stacked body (`band`), with a bold median line and a
 * faint p95 envelope on top. Recharts stacks the two areas, so the body floats on the p25 base.
 */
function DepthChart({
  heading,
  points,
  band,
  valueFormatter,
}: {
  heading: string;
  points: DepthPoint[];
  band: BandAccessors;
  valueFormatter: (value: number) => string;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">{heading}</p>
      <ChartContainer config={CHART_CONFIG} className="!aspect-auto h-[130px] w-full">
        <ComposedChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="depth"
            type="number"
            domain={[0, 'dataMax']}
            tick={{ fontSize: 10 }}
            tickMargin={6}
            allowDecimals={false}
            label={{
              value: 'conversation depth (turn #)',
              position: 'insideBottom',
              offset: -1,
              fontSize: 10,
              fill: 'var(--color-muted-foreground)',
            }}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            width={46}
            tickFormatter={(v: number) => valueFormatter(v)}
          />
          <ChartTooltip
            cursor={{ stroke: 'var(--color-border)' }}
            content={<DepthTooltip band={band} valueFormatter={valueFormatter} />}
          />
          <Area
            dataKey={band.p25}
            stackId="band"
            stroke="none"
            fill="transparent"
            isAnimationActive={false}
          />
          <Area
            dataKey={band.band}
            stackId="band"
            stroke="none"
            fill="var(--color-chart-1)"
            fillOpacity={0.16}
            isAnimationActive={false}
          />
          <Line
            dataKey={band.p95}
            stroke="var(--color-chart-1)"
            strokeWidth={1}
            strokeOpacity={0.4}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey={band.p50}
            stroke="var(--color-chart-1)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}

interface DepthTooltipPayloadItem {
  payload?: DepthPoint;
}

/**
 * Reports the real per-turn quantiles at the hovered depth from the row's own payload, not the
 * chart's stacked series. The two Areas that draw the band are a transparent `p25` base and a raw
 * `p75 - p25` delta (`band`); surfacing those directly would show a phantom "band: $3.00" metric, so
 * the tooltip reads p25/p50/p75/p95 and the sample count off the point instead.
 */
function DepthTooltip({
  active,
  payload,
  band,
  valueFormatter,
}: {
  active?: boolean;
  payload?: DepthTooltipPayloadItem[];
  band: BandAccessors;
  valueFormatter: (value: number) => string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const rows: Array<[string, number]> = [
    ['p95', point[band.p95]],
    ['p75', point[band.p75]],
    ['median', point[band.p50]],
    ['p25', point[band.p25]],
  ];
  return (
    <div className="grid min-w-[9rem] gap-1 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        Turn {formatNumber(point.depth)}
        <span className="ml-1.5 font-normal text-muted-foreground">
          · {formatNumber(point.sampleCount)} conv.
        </span>
      </div>
      {rows.map(([name, value]) => (
        <div key={name} className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{name}</span>
          <span className="font-mono tabular-nums text-foreground">{valueFormatter(value)}</span>
        </div>
      ))}
    </div>
  );
}
