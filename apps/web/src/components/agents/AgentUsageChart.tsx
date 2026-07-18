'use client';

import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
import {
  formatNumber,
  formatCurrency,
  formatBucketTick,
  formatBucketTooltip,
  parseTinybirdDate,
} from '@/lib/format';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { OTHER_GROUP, OTHER_LABEL, pivotByGroup } from './pivot';
import {
  AGENT_GROUPED_METRIC_KEY,
  AGENT_GROUP_COLORS,
  AGENT_METRIC_CONFIG,
  AGENT_METRIC_KEYS,
  AGENT_METRIC_VALUE_KIND,
  USAGE_GROUP_TOP_N,
  type AgentChartStyle,
  type AgentGranularity,
  type AgentGroupBy,
  type AgentMetric,
  type AgentTimeseriesRow,
} from './types';

interface Series {
  /**
   * Safe string key used as the Recharts dataKey, chart config key, and React key. Grouped
   * series use synthetic ids (g0, g1, …) so dotted group values (e.g. model "gpt-5.5") never
   * hit Recharts' dot-path parsing; a string dataKey (vs a function) is also what lets
   * Recharts compute the Y-axis domain.
   */
  id: string;
  /** Display name shown in the legend/tooltip (repo names are resolved here). */
  name: string;
  /** Raw group value used for click-to-filter (repo fingerprint, source, or model). */
  value: string;
  color: string;
}

export function AgentUsageChart({
  data,
  metric,
  groupBy,
  granularity,
  chartStyle,
  onGroupClick,
  labelFor,
}: {
  data: AgentTimeseriesRow[];
  metric: AgentMetric;
  groupBy: AgentGroupBy;
  granularity: AgentGranularity;
  chartStyle: AgentChartStyle;
  /** Toggle a group value into the active filter (click-to-filter); only when grouped. */
  onGroupClick?: (value: string) => void;
  /** Resolve a raw group value to a display name (e.g. repo fingerprint -> owner/repo). */
  labelFor?: (value: string) => string;
}) {
  const { chartData, series, config } = useMemo(() => {
    if (groupBy !== 'none') {
      const topN = groupBy === 'repo' || groupBy === 'model' ? USAGE_GROUP_TOP_N : undefined;
      const { data: wide, groups } = pivotByGroup(data, AGENT_GROUPED_METRIC_KEY[metric], topN);
      const s: Series[] = groups.map((group, i) => ({
        id: `g${i}`,
        name: group === OTHER_GROUP ? OTHER_LABEL : (labelFor?.(group) ?? group),
        value: group,
        color: AGENT_GROUP_COLORS[i % AGENT_GROUP_COLORS.length],
      }));
      // Re-key the wide rows from raw group value -> synthetic series id so every dataKey is
      // a plain string (correct Y-axis domain + no dot-path issues).
      const rekeyed = wide.map((row) => {
        const out: Record<string, string | number> = { bucket_start: String(row.bucket_start) };
        for (const entry of s) out[entry.id] = Number(row[entry.value] ?? 0);
        return out;
      });
      const cfg: ChartConfig = Object.fromEntries(
        s.map((entry) => [entry.id, { label: entry.name, color: entry.color }]),
      );
      return { chartData: rekeyed, series: s, config: cfg };
    }

    const metricConfig = AGENT_METRIC_CONFIG[metric];
    const s: Series[] = AGENT_METRIC_KEYS[metric].map((key) => ({
      id: key,
      name: String(metricConfig[key]?.label ?? key),
      value: key,
      color: metricConfig[key]?.color ?? 'var(--color-chart-1)',
    }));
    return {
      chartData: data as unknown as Array<Record<string, string | number>>,
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
  const stacked = chartStyle === 'stacked';

  // Legend clicks expose the display name; map it back to the raw value for filtering.
  const nameToValue = new Map(series.map((s) => [s.name, s.value]));
  const handleFilterClick = (value: string) => {
    // "Other" is an aggregate of many groups, so it is intentionally not filterable.
    if (clickable && value && value !== OTHER_GROUP) onGroupClick?.(value);
  };

  const hourly =
    granularity === 'hour' ||
    (granularity === 'auto' &&
      data.length > 1 &&
      Math.abs(
        parseTinybirdDate(data[1].bucket_start).getTime() -
          parseTinybirdDate(data[0].bucket_start).getTime(),
      ) < 86_400_000);

  return (
    <ChartContainer config={config} className="!aspect-auto h-[320px] w-full">
      <AreaChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis
          dataKey="bucket_start"
          tickFormatter={(v: string) => formatBucketTick(v, hourly)}
          tick={{ fontSize: 11 }}
          tickMargin={8}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={(v: number) => formatValue(v)}
          tick={{ fontSize: 11 }}
          width={64}
          tickMargin={4}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label: string) =>
                hourly ? formatBucketTooltip(String(label)) : formatBucketTick(String(label), false)
              }
              valueFormatter={(v) => formatValue(v)}
            />
          }
        />
        <Legend
          wrapperStyle={{ fontSize: 11, paddingTop: 8, cursor: clickable ? 'pointer' : undefined }}
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
        {series.map((s) => (
          <Area
            key={s.id}
            type="monotone"
            dataKey={s.id}
            name={s.name}
            stackId={stacked ? 'stack' : undefined}
            fill={s.color}
            stroke={s.color}
            fillOpacity={stacked ? 0.55 : 0}
            strokeWidth={2}
            isAnimationActive={false}
            style={clickable ? { cursor: 'pointer' } : undefined}
            onClick={clickable ? () => handleFilterClick(s.value) : undefined}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}
