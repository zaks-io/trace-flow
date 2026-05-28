'use client';

import { useMemo } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
import { formatNumber, formatCurrency } from '@/lib/format';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { OTHER_GROUP, pivotByGroup } from './pivot';
import {
  AGENT_GROUPED_METRIC_KEY,
  AGENT_GROUP_COLORS,
  AGENT_METRIC_CONFIG,
  AGENT_METRIC_KEYS,
  AGENT_METRIC_VALUE_KIND,
  REPO_TOP_N,
  type AgentChartStyle,
  type AgentGroupBy,
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

interface Series {
  /** CSS-safe id used as the chart config key and React key. */
  id: string;
  /** Display name shown in the legend/tooltip (repo names are resolved here). */
  name: string;
  /** Raw group value used for click-to-filter (repo fingerprint, source, or model). */
  value: string;
  /** Reads this series' value from a chart row (function form avoids Recharts dot-path parsing). */
  accessor: (row: Record<string, unknown>) => number;
  color: string;
}

export function AgentUsageChart({
  data,
  metric,
  groupBy,
  chartStyle,
  onGroupClick,
  labelFor,
}: {
  data: AgentTimeseriesRow[];
  metric: AgentMetric;
  groupBy: AgentGroupBy;
  chartStyle: AgentChartStyle;
  /** Toggle a group value into the active filter (click-to-filter); only when grouped. */
  onGroupClick?: (value: string) => void;
  /** Resolve a raw group value to a display name (e.g. repo fingerprint -> owner/repo). */
  labelFor?: (value: string) => string;
}) {
  const { chartData, series, config } = useMemo(() => {
    if (groupBy !== 'none') {
      const topN = groupBy === 'repo' ? REPO_TOP_N : undefined;
      const { data: wide, groups } = pivotByGroup(data, AGENT_GROUPED_METRIC_KEY[metric], topN);
      const s: Series[] = groups.map((group, i) => ({
        id: `g${i}`,
        name: group === OTHER_GROUP ? OTHER_GROUP : (labelFor?.(group) ?? group),
        value: group,
        accessor: (row) => Number(row[group] ?? 0),
        color: AGENT_GROUP_COLORS[i % AGENT_GROUP_COLORS.length],
      }));
      const cfg: ChartConfig = Object.fromEntries(
        s.map((entry) => [entry.id, { label: entry.name, color: entry.color }]),
      );
      return { chartData: wide as Array<Record<string, unknown>>, series: s, config: cfg };
    }

    const metricConfig = AGENT_METRIC_CONFIG[metric];
    const s: Series[] = AGENT_METRIC_KEYS[metric].map((key) => ({
      id: key,
      name: String(metricConfig[key]?.label ?? key),
      value: key,
      accessor: (row) => Number(row[key] ?? 0),
      color: metricConfig[key]?.color ?? 'var(--color-chart-1)',
    }));
    return {
      chartData: data as unknown as Array<Record<string, unknown>>,
      series: s,
      config: metricConfig,
    };
  }, [data, metric, groupBy, labelFor]);

  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent activity in this range</p>;
  }

  if (series.length === 0) {
    return <p className="text-sm text-muted-foreground">No data for this grouping</p>;
  }

  const isCurrency = AGENT_METRIC_VALUE_KIND[metric] === 'currency';
  const formatValue = (v: number) => (isCurrency ? formatCurrency(v) : formatNumber(v));
  const clickable = groupBy !== 'none' && Boolean(onGroupClick);
  // Legend clicks expose the display name; map it back to the raw value for filtering.
  const nameToValue = new Map(series.map((s) => [s.name, s.value]));
  const handleFilterClick = (value: string) => {
    // "Other" is an aggregate of many repos, so it is intentionally not filterable.
    if (clickable && value && value !== OTHER_GROUP) onGroupClick?.(value);
  };

  const hourly =
    data.length > 1 &&
    Math.abs(new Date(data[1].bucket_start).getTime() - new Date(data[0].bucket_start).getTime()) <
      86_400_000;
  const tickFormatter = (v: string) => formatTickDate(v, hourly);
  const tooltipLabelFormatter = (label: string) =>
    hourly ? formatTooltipDate(String(label)) : formatTickDate(String(label), false);

  const axes = (
    <>
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
      {groupBy !== 'none' && (
        <Legend
          wrapperStyle={{ fontSize: 11, cursor: clickable ? 'pointer' : undefined }}
          iconType="circle"
          iconSize={8}
          onClick={
            clickable
              ? (entry) => {
                  const name = String(entry.value);
                  handleFilterClick(nameToValue.get(name) ?? name);
                }
              : undefined
          }
        />
      )}
    </>
  );

  return (
    <ChartContainer config={config} className="!aspect-auto h-[300px] w-full">
      {chartStyle === 'line' ? (
        <LineChart data={chartData}>
          {axes}
          {series.map((s) => (
            <Line
              key={s.id}
              type="monotone"
              dataKey={s.accessor}
              name={s.name}
              stroke={s.color}
              dot={false}
              strokeWidth={2}
              style={clickable ? { cursor: 'pointer' } : undefined}
              onClick={clickable ? () => handleFilterClick(s.value) : undefined}
            />
          ))}
        </LineChart>
      ) : (
        <AreaChart data={chartData}>
          {axes}
          {series.map((s) => (
            <Area
              key={s.id}
              type="monotone"
              dataKey={s.accessor}
              name={s.name}
              stackId="1"
              fill={s.color}
              stroke={s.color}
              fillOpacity={0.6}
              style={clickable ? { cursor: 'pointer' } : undefined}
              onClick={clickable ? () => handleFilterClick(s.value) : undefined}
            />
          ))}
        </AreaChart>
      )}
    </ChartContainer>
  );
}
