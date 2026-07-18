'use client';

import { useState } from 'react';
import { AgentUsageChart } from './AgentUsageChart';
import type { AnalystPageContextReference } from '@/components/analyst/pageContext';
import { BentoCell } from './BentoCell';
import { SegmentedControl } from './SegmentedControl';
import {
  AGENT_GROUP_BY_LABEL,
  USAGE_GROUP_TOP_N,
  type AgentChartStyle,
  type AgentMetric,
  type AgentTimeseriesRow,
  type AgentUsageGroupBy,
} from './types';

/** The metrics that read cleanly per repo over time; cost is the default. */
const USAGE_METRICS = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'sessions', label: 'Sessions' },
] as const satisfies ReadonlyArray<{ value: AgentMetric; label: string }>;

const CHART_STYLES = [
  { value: 'line', label: 'Lines' },
  { value: 'stacked', label: 'Stacked' },
] as const satisfies ReadonlyArray<{ value: AgentChartStyle; label: string }>;

type UsageMetric = (typeof USAGE_METRICS)[number]['value'];

const USAGE_GROUPS = [
  { value: 'repo', label: 'Repo' },
  { value: 'model', label: 'Model' },
  { value: 'source', label: 'Source' },
] as const satisfies ReadonlyArray<{ value: AgentUsageGroupBy; label: string }>;

/**
 * Always-visible grouped usage chart. Reuses the shared {@link AgentUsageChart} renderer and owns
 * the split dimension, metric, and chart-style controls.
 */
export function UsageOverTimeCell({
  usageSeries,
  groupBy,
  onGroupByChange,
  onGroupToggle,
  labelFor,
  contextReference,
}: {
  /** Daily grouped rows from `agent_usage_timeseries`. */
  usageSeries: AgentTimeseriesRow[];
  groupBy: AgentUsageGroupBy;
  onGroupByChange: (next: AgentUsageGroupBy) => void;
  /** Toggle a series into its matching Source, Model, or Repo filter. */
  onGroupToggle: (value: string) => void;
  /** Resolve a repo fingerprint to a display name. */
  labelFor: (value: string) => string;
  contextReference?: AnalystPageContextReference;
}) {
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const [chartStyle, setChartStyle] = useState<AgentChartStyle>('line');
  const groupLabel = AGENT_GROUP_BY_LABEL[groupBy].toLowerCase();
  const isCapped = groupBy === 'repo' || groupBy === 'model';
  const caveat = `Cost is an estimate (lower bound). ${
    isCapped
      ? `Top ${USAGE_GROUP_TOP_N} ${groupLabel}s are charted; the rest roll into "Other". `
      : ''
  }Click a ${groupLabel} to filter.`;

  return (
    <BentoCell
      title="Usage over time"
      hint={`by ${groupLabel}`}
      caveat={caveat}
      contextReference={contextReference}
      toolbar={
        <div className="flex items-center gap-2">
          <SegmentedControl
            ariaLabel="Group usage by"
            value={groupBy}
            options={USAGE_GROUPS}
            onChange={onGroupByChange}
          />
          <SegmentedControl
            ariaLabel="Metric"
            value={metric}
            options={USAGE_METRICS}
            onChange={setMetric}
          />
          <SegmentedControl
            ariaLabel="Chart style"
            value={chartStyle}
            options={CHART_STYLES}
            onChange={setChartStyle}
          />
        </div>
      }
    >
      <AgentUsageChart
        data={usageSeries}
        metric={metric}
        groupBy={groupBy}
        granularity="day"
        chartStyle={chartStyle}
        onGroupClick={onGroupToggle}
        labelFor={groupBy === 'repo' ? labelFor : undefined}
      />
    </BentoCell>
  );
}
