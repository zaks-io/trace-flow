'use client';

import { useMemo } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, XAxis, YAxis } from 'recharts';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';
import {
  buildCostBuckets,
  buildLorenzPoints,
  classifyCostShape,
  costShapeGloss,
} from './costDistribution';
import type { RequestStatsRow } from './types';

const HISTOGRAM_CONFIG = { sum: { label: 'Spend', color: 'var(--color-chart-1)' } };
const LORENZ_CONFIG = { costPct: { label: 'Cost share', color: 'var(--color-chart-1)' } };

const VERDICT_TONE: Record<string, string> = {
  uniform: 'text-emerald-400',
  moderate: 'text-amber-400',
  'fat-tailed': 'text-rose-400',
  insufficient: 'text-muted-foreground',
};

/**
 * Per-request cost SHAPE for the current slice (one API key / operation / model, per the active
 * filters). Answers "uniform vs fat-tailed" so the user knows the optimization lever: lower the
 * per-call cost vs hunt the outliers. The decile histogram plots SUMMED spend per cost band (where
 * the dollars are); the Lorenz curve shows how concentrated that spend is, with the bias-corrected
 * Gini as the single number. All robust/quantileExact per ADR 0021 — no mean/stddev.
 */
export function LlmCostDistributionCard({
  requestStats,
  dimensionLabel,
}: {
  requestStats: RequestStatsRow | undefined;
  dimensionLabel: string;
}) {
  const buckets = useMemo(
    () => (requestStats ? buildCostBuckets(requestStats) : []),
    [requestStats],
  );
  const lorenz = useMemo(
    () => (requestStats ? buildLorenzPoints(requestStats) : []),
    [requestStats],
  );

  if (!requestStats || requestStats.request_count === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <Header dimensionLabel={dimensionLabel} />
        <p className="mt-4 flex h-[160px] items-center text-sm text-muted-foreground">
          No requests in this slice.
        </p>
      </div>
    );
  }

  const verdict = classifyCostShape(requestStats);
  const maxSum = buckets.reduce((m, b) => Math.max(m, b.sum), 0);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <Header dimensionLabel={dimensionLabel} />

      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Stat label="median / request" value={formatCurrency(requestStats.cost_p50)} />
        <Stat
          label="IQR"
          value={`${formatCurrency(requestStats.cost_p25)} – ${formatCurrency(requestStats.cost_p75)}`}
        />
        <Stat label="p95" value={formatCurrency(requestStats.cost_p95)} />
        <div className="ml-auto text-right">
          <span className={`font-mono text-xl font-semibold tabular-nums ${VERDICT_TONE[verdict]}`}>
            {verdict === 'insufficient' ? '—' : requestStats.gini.toFixed(2)}
          </span>
          <span className="ml-1.5 text-xs text-muted-foreground">Gini</span>
        </div>
      </div>

      <p className={`mt-1 text-xs ${VERDICT_TONE[verdict]}`}>{costShapeGloss(requestStats)}</p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Spend by cost band
          </p>
          {buckets.length === 0 ? (
            <p className="flex h-[150px] items-center text-sm text-muted-foreground">
              Not enough spread to bucket spend.
            </p>
          ) : (
            <ChartContainer config={HISTOGRAM_CONFIG} className="!aspect-auto h-[150px] w-full">
              <BarChart data={buckets} margin={{ top: 4, right: 8, bottom: 16, left: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9 }}
                  tickMargin={6}
                  angle={-30}
                  textAnchor="end"
                  interval={0}
                  height={36}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  width={52}
                  tickFormatter={(v) => formatCurrency(v)}
                />
                <ChartTooltip content={<BucketTooltip />} />
                <Bar dataKey="sum" radius={2}>
                  {buckets.map((b, i) => (
                    <Cell
                      key={b.label}
                      fill="var(--color-chart-1)"
                      fillOpacity={maxSum > 0 ? 0.35 + 0.65 * (b.sum / maxSum) : 0.5}
                      stroke={
                        i === buckets.length - 1 && b.sum > 0 ? 'var(--color-chart-1)' : undefined
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          )}
        </div>

        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Spend concentration (Lorenz)
          </p>
          <ChartContainer config={LORENZ_CONFIG} className="!aspect-auto h-[150px] w-full">
            <AreaChart data={lorenz} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                type="number"
                dataKey="requestPct"
                domain={[0, 1]}
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => formatPercent(v * 100)}
              />
              <YAxis
                type="number"
                domain={[0, 1]}
                tick={{ fontSize: 10 }}
                width={40}
                tickFormatter={(v) => formatPercent(v * 100)}
              />
              <ChartTooltip content={<LorenzTooltip />} />
              {/* Diagonal = perfectly even spend; the gap to the curve is the concentration. */}
              <Line
                type="linear"
                dataKey="requestPct"
                dot={false}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
                strokeWidth={1}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="costPct"
                stroke="var(--color-chart-1)"
                fill="var(--color-chart-1)"
                fillOpacity={0.18}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        </div>
      </div>
    </div>
  );
}

function Header({ dimensionLabel }: { dimensionLabel: string }) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-medium text-foreground">Cost distribution per request</h3>
      <span className="text-xs text-muted-foreground">{dimensionLabel}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-mono text-xl font-semibold tabular-nums text-foreground">{value}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function BucketTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { label: string; count: number; sum: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  return (
    <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium text-foreground">{b.label}</div>
      <Row label="spend" value={formatCurrency(b.sum)} />
      <Row label="requests" value={formatNumber(b.count)} />
    </div>
  );
}

function LorenzTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { requestPct: number; costPct: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <Row label="requests" value={formatPercent(p.requestPct * 100)} />
      <Row label="of spend" value={formatPercent(p.costPct * 100)} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}
