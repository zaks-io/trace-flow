'use client';

import { useState } from 'react';
import { AgentUsageChart } from './AgentUsageChart';
import { BentoCell } from './BentoCell';
import { SegmentedControl } from './SegmentedControl';
import {
  REPO_TOP_N,
  type AgentChartStyle,
  type AgentMetric,
  type AgentTimeseriesRow,
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

/**
 * Always-visible "usage over time, grouped by repo" — the projects-overlapping view from the
 * old design. Reuses the shared {@link AgentUsageChart} renderer (repo pivot, top-N + Other,
 * legend click-to-filter); this cell only owns the metric + line/stacked controls.
 */
export function UsageOverTimeCell({
  repoSeries,
  onRepoToggle,
  labelFor,
}: {
  /** Daily, repo-grouped rows from `agent_usage_timeseries` (group_by=repo). */
  repoSeries: AgentTimeseriesRow[];
  /** Toggle a repo into the active Repo filter when its legend/series is clicked. */
  onRepoToggle: (repoFingerprint: string) => void;
  /** Resolve a repo fingerprint to a display name. */
  labelFor: (value: string) => string;
}) {
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const [chartStyle, setChartStyle] = useState<AgentChartStyle>('line');

  return (
    <BentoCell
      title="Usage over time"
      hint="by repository"
      caveat={`Cost is an estimate (lower bound). Top ${REPO_TOP_N} repos are charted; the rest roll into "Other". Click a repo to filter.`}
      toolbar={
        <div className="flex items-center gap-2">
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
        data={repoSeries}
        metric={metric}
        groupBy="repo"
        granularity="day"
        chartStyle={chartStyle}
        onGroupClick={onRepoToggle}
        labelFor={labelFor}
      />
    </BentoCell>
  );
}
