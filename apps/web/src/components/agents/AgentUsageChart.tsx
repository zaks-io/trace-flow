'use client';

import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatNumber, formatCurrency } from '@/lib/format';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import {
  AGENT_METRIC_CONFIG,
  AGENT_METRIC_KEYS,
  AGENT_METRIC_VALUE_KIND,
  type AgentMetric,
  type AgentTimeseriesRow,
} from './types';

function formatTickDate(value: string, includeTime: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (includeTime) {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      hour12: true,
    });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTooltipDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function AgentUsageChart({
  data,
  metric,
}: {
  data: AgentTimeseriesRow[];
  metric: AgentMetric;
}) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent activity in this range</p>;
  }

  const config = AGENT_METRIC_CONFIG[metric];
  const keys = AGENT_METRIC_KEYS[metric];
  const isCurrency = AGENT_METRIC_VALUE_KIND[metric] === 'currency';
  const formatValue = (v: number) => (isCurrency ? formatCurrency(v) : formatNumber(v));

  const hourly =
    data.length > 1 &&
    Math.abs(new Date(data[1].bucket_start).getTime() - new Date(data[0].bucket_start).getTime()) <
      86_400_000;
  const tickFormatter = (v: string) => formatTickDate(v, hourly);
  const tooltipLabelFormatter = (label: string) =>
    hourly ? formatTooltipDate(String(label)) : formatTickDate(String(label), false);

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
        <YAxis tickFormatter={(v: number) => formatValue(v)} tick={{ fontSize: 11 }} width={60} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={tooltipLabelFormatter}
              valueFormatter={(v) => formatValue(v)}
            />
          }
        />
        {keys.map((key) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stackId="1"
            fill={`var(--color-${key})`}
            stroke={`var(--color-${key})`}
            fillOpacity={0.6}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}
