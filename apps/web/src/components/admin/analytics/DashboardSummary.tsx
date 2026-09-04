import { Activity, AlertTriangle, Database, Gauge } from 'lucide-react';
import { ACCENT } from './constants';
import {
  formatBytes,
  formatCompactNumber,
  formatDuration,
  formatInteger,
  formatPercentage,
} from './format';
import { OverviewChart } from './OverviewChart';
import { SummaryCard } from './SummaryCard';
import type { ChartMetric, DashboardData } from './types';

export function DashboardSummary({
  data,
  chartMetric,
  setChartMetric,
}: {
  data: DashboardData;
  chartMetric: ChartMetric;
  setChartMetric: (value: ChartMetric) => void;
}) {
  return (
    <>
      <div className="stagger-children grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Requests"
          value={formatCompactNumber(data.summary.requestCount)}
          description="Weighted event count using sum(_sample_interval)."
          icon={<Activity className="h-4 w-4" />}
          accentColor={ACCENT.requests}
        />
        <SummaryCard
          title="Server Errors"
          value={formatPercentage(data.summary.serverErrorRate)}
          description={`${formatInteger(data.summary.serverErrorCount)} weighted server errors.`}
          icon={<AlertTriangle className="h-4 w-4" />}
          accentColor={ACCENT.errors}
        />
        <SummaryCard
          title="P95 Latency"
          value={formatDuration(data.summary.p95LatencyMs)}
          description={`P50 ${formatDuration(data.summary.p50LatencyMs)} \u2022 P99 ${formatDuration(data.summary.p99LatencyMs)}`}
          icon={<Gauge className="h-4 w-4" />}
          accentColor={ACCENT.latency}
        />
        <SummaryCard
          title="Token Volume"
          value={formatCompactNumber(data.summary.totalTokens)}
          description={`${formatBytes(data.summary.responseBytes)} of response payloads.`}
          icon={<Database className="h-4 w-4" />}
          accentColor={ACCENT.tokens}
        />
      </div>

      <OverviewChart rows={data.timeseries} metric={chartMetric} onMetricChange={setChartMetric} />

      {/* Operational Totals */}
      <div className="stagger-children grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div
          className="rounded-lg border border-border/60 border-l-2 p-4"
          style={{ borderLeftColor: ACCENT.skipRate }}
        >
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Skip Rate</p>
          <p className="tabular-mono mt-2 text-xl font-semibold">
            {formatPercentage(data.summary.skipRate)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatInteger(data.summary.skipCount)} weighted skipped requests
          </p>
        </div>
        <div
          className="rounded-lg border border-border/60 border-l-2 p-4"
          style={{ borderLeftColor: ACCENT.ttfb }}
        >
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Avg TTFB</p>
          <p className="tabular-mono mt-2 text-xl font-semibold">
            {formatDuration(data.summary.avgTtfbMs)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            P95 {formatDuration(data.summary.p95TtfbMs)}
          </p>
        </div>
        <div
          className="rounded-lg border border-border/60 border-l-2 p-4"
          style={{ borderLeftColor: ACCENT.promptComp }}
        >
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Prompt vs Completion
          </p>
          <p className="tabular-mono mt-2 text-xl font-semibold">
            {formatCompactNumber(data.summary.promptTokens)} /{' '}
            {formatCompactNumber(data.summary.completionTokens)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Cache reads {formatCompactNumber(data.summary.cacheReadTokens)}
          </p>
        </div>
        <div
          className="rounded-lg border border-border/60 border-l-2 p-4"
          style={{ borderLeftColor: ACCENT.bytes }}
        >
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Average Latency
          </p>
          <p className="tabular-mono mt-2 text-xl font-semibold">
            {formatDuration(data.summary.avgLatencyMs)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Total bytes {formatBytes(data.summary.responseBytes)}
          </p>
        </div>
      </div>
    </>
  );
}
