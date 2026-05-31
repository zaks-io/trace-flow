'use client';

import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import {
  formatNumber,
  formatCurrency,
  formatDuration,
  formatBucketTick,
  formatBucketTooltip,
  parseTinybirdDate,
} from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import {
  costChartConfig,
  durationChartConfig,
  tokensChartConfig,
  requestsChartConfig,
} from './types';
import type { TimeseriesRow, TimeseriesMetric } from './types';

export function CostTimeseriesChart({
  data,
  metric,
}: {
  data: TimeseriesRow[];
  metric: TimeseriesMetric;
}) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No usage data available</p>;
  }

  const hourly =
    data.length > 1 &&
    Math.abs(
      parseTinybirdDate(data[1].bucket_start).getTime() -
        parseTinybirdDate(data[0].bucket_start).getTime(),
    ) < 86_400_000;
  const tickFormatter = (v: string) => formatBucketTick(v, hourly);
  const tooltipLabelFormatter = (label: string) =>
    hourly ? formatBucketTooltip(String(label)) : formatBucketTick(String(label), false);

  if (metric === 'cost') {
    return (
      <ChartContainer config={costChartConfig} className="!aspect-auto h-[300px] w-full">
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket_start"
            tickFormatter={tickFormatter}
            tick={{ fontSize: 11 }}
            minTickGap={50}
          />
          <YAxis
            tickFormatter={(v: number) => formatCurrency(v)}
            tick={{ fontSize: 11 }}
            width={60}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={tooltipLabelFormatter}
                valueFormatter={(v) => formatCurrency(v)}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="input_cost_usd"
            stackId="1"
            fill="var(--color-input_cost_usd)"
            stroke="var(--color-input_cost_usd)"
            fillOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="output_cost_usd"
            stackId="1"
            fill="var(--color-output_cost_usd)"
            stroke="var(--color-output_cost_usd)"
            fillOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="cache_read_cost_usd"
            stackId="1"
            fill="var(--color-cache_read_cost_usd)"
            stroke="var(--color-cache_read_cost_usd)"
            fillOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="cache_creation_cost_usd"
            stackId="1"
            fill="var(--color-cache_creation_cost_usd)"
            stroke="var(--color-cache_creation_cost_usd)"
            fillOpacity={0.6}
          />
          <Area
            type="monotone"
            dataKey="reasoning_cost_usd"
            stackId="1"
            fill="var(--color-reasoning_cost_usd)"
            stroke="var(--color-reasoning_cost_usd)"
            fillOpacity={0.6}
          />
        </AreaChart>
      </ChartContainer>
    );
  }

  if (metric === 'duration') {
    return (
      <ChartContainer config={durationChartConfig} className="!aspect-auto h-[300px] w-full">
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="bucket_start"
            tickFormatter={tickFormatter}
            tick={{ fontSize: 11 }}
            minTickGap={50}
          />
          <YAxis
            tickFormatter={(v: number) => formatDuration(v)}
            tick={{ fontSize: 11 }}
            width={60}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={tooltipLabelFormatter}
                valueFormatter={(v) => formatDuration(v)}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="avg_duration_ms"
            fill="var(--color-avg_duration_ms)"
            stroke="var(--color-avg_duration_ms)"
            fillOpacity={0.3}
          />
          <Area
            type="monotone"
            dataKey="p95_duration_ms"
            fill="var(--color-p95_duration_ms)"
            stroke="var(--color-p95_duration_ms)"
            fillOpacity={0.15}
          />
        </AreaChart>
      </ChartContainer>
    );
  }

  const config = metric === 'tokens' ? tokensChartConfig : requestsChartConfig;
  const dataKey = metric === 'tokens' ? 'total_tokens' : 'request_count';

  return (
    <ChartContainer config={config} className="!aspect-auto h-[300px] w-full">
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="bucket_start"
          tickFormatter={tickFormatter}
          tick={{ fontSize: 11 }}
          minTickGap={50}
        />
        <YAxis tickFormatter={(v: number) => formatNumber(v)} tick={{ fontSize: 11 }} width={60} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={tooltipLabelFormatter}
              valueFormatter={(v) => formatNumber(v)}
            />
          }
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          fill={`var(--color-${dataKey})`}
          stroke={`var(--color-${dataKey})`}
          fillOpacity={0.3}
        />
      </AreaChart>
    </ChartContainer>
  );
}
