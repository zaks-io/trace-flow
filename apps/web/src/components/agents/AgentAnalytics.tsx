'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, DollarSign, Hash, MessageSquare, Wrench, X } from 'lucide-react';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { TIME_RANGES } from '@/components/usage/types';
import { useAgentFilters } from './useAgentFilters';
import { useAgentData } from './useAgentData';
import { useRepoDirectory } from '@/hooks/useRepoDirectory';
import {
  AGENT_SOURCES,
  AGENT_METRICS,
  AGENT_METRIC_LABEL,
  AGENT_GROUP_BY,
  AGENT_GROUP_BY_LABEL,
  AGENT_GRANULARITIES,
  AGENT_GRANULARITY_LABEL,
  type AgentChartStyle,
  type AgentGroupBy,
  type AgentMetric,
} from './types';
import type { AgentBreakdownDimension } from './types';
import { MultiFilterDropdown } from './MultiFilterDropdown';
import { AgentUsageChart } from './AgentUsageChart';
import { AgentKpiCards } from './AgentKpiCards';
import { AgentBreakdownPanels } from './AgentBreakdownPanels';
import { FailureLeaderboardTable } from './FailureLeaderboardTable';
import { ToolDeltaTable } from './ToolDeltaTable';
import { AgentSessionsTable } from './AgentSessionsTable';

const METRIC_ICON: Record<AgentMetric, React.ComponentType<{ className?: string }>> = {
  cost: DollarSign,
  tokens: Hash,
  messages: MessageSquare,
  sessions: Bot,
  'tool-events': Wrench,
};

export function AgentAnalytics() {
  const {
    timeRange,
    setTimeRange,
    sources,
    toggleSource,
    models,
    toggleModel,
    repos,
    toggleRepo,
    groupBy,
    setGroupBy,
    granularity,
    setGranularity,
    hasFilters,
    clearFilters,
    filterParams,
  } = useAgentFilters();
  const { timeseries, summary, failures, deltas, isLoading, hasError, isEmpty } = useAgentData({
    filterParams,
    groupBy,
    granularity,
    models,
  });
  const [metric, setMetric] = useState<AgentMetric>('cost');
  const [chartStyle, setChartStyle] = useState<AgentChartStyle>('stacked');

  // Resolve repo_fingerprint -> display name. Loaded whenever there is data to show, since
  // the session table renders repo names even when not grouping/filtering by repo.
  const windowParams = useMemo(
    () => ({ start_time_ms: filterParams.start_time_ms, end_time_ms: filterParams.end_time_ms }),
    [filterParams.start_time_ms, filterParams.end_time_ms],
  );
  const repoLabelMap = useRepoDirectory(windowParams, !isEmpty);
  const labelFor = useMemo(
    () => (value: string) => repoLabelMap.get(value) ?? value,
    [repoLabelMap],
  );
  const repoOptions = useMemo(() => {
    const set = new Set(repoLabelMap.keys());
    for (const r of repos) set.add(r);
    return [...set];
  }, [repoLabelMap, repos]);

  // Model is high-cardinality and only appears in the data once grouped by model, so
  // accumulate the values seen across group-by-model fetches to populate the filter.
  const [seenModels, setSeenModels] = useState<string[]>([]);
  useEffect(() => {
    if (groupBy !== 'model') return;
    setSeenModels((prev) => {
      const set = new Set(prev);
      let changed = false;
      for (const row of timeseries) {
        if (row.group_value && !set.has(row.group_value)) {
          set.add(row.group_value);
          changed = true;
        }
      }
      return changed ? [...set] : prev;
    });
  }, [groupBy, timeseries]);
  const modelOptions = useMemo(() => {
    const set = new Set(seenModels);
    for (const m of models) set.add(m);
    return [...set];
  }, [seenModels, models]);

  // Tool Events carry no model, so Model grouping is unavailable for that metric.
  const isGroupDisabled = (g: AgentGroupBy) => g === 'model' && metric === 'tool-events';

  const selectMetric = (m: AgentMetric) => {
    setMetric(m);
    if (m === 'tool-events' && groupBy === 'model') setGroupBy('none');
  };

  // Click a series/legend entry to toggle that value into the active dimension's filter.
  const onGroupClick = (value: string) => {
    if (groupBy === 'source') toggleSource(value);
    else if (groupBy === 'model') toggleModel(value);
    else if (groupBy === 'repo') toggleRepo(value);
  };

  // Breakdown panels cross-filter the page: a row click toggles its dimension's filter.
  const breakdownSelected = (dimension: AgentBreakdownDimension) =>
    dimension === 'source' ? sources : dimension === 'model' ? models : repos;
  const breakdownToggle = (dimension: AgentBreakdownDimension, value: string) => {
    if (dimension === 'source') toggleSource(value);
    else if (dimension === 'model') toggleModel(value);
    else toggleRepo(value);
  };

  const MetricIcon = METRIC_ICON[metric];

  return (
    <div className="animate-fade-in">
      <PageToolbar className="flex-col items-start gap-4 lg:flex-row lg:items-center">
        <div>
          <h1 className="text-sm font-medium text-foreground">Agent Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Estimated cost, tokens, and activity from coding-agent transcripts.
          </p>
        </div>
        <div className="flex-1" />
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3 w-3" />
            Clear filters
          </button>
        )}
        <MultiFilterDropdown
          label="Source"
          values={sources}
          options={[...AGENT_SOURCES]}
          onToggle={toggleSource}
          onClear={() => sources.forEach(toggleSource)}
        />
        <MultiFilterDropdown
          label="Model"
          values={models}
          options={modelOptions}
          onToggle={toggleModel}
          onClear={() => models.forEach(toggleModel)}
        />
        <MultiFilterDropdown
          label="Repo"
          values={repos}
          options={repoOptions}
          onToggle={toggleRepo}
          onClear={() => repos.forEach(toggleRepo)}
          labelMap={repoLabelMap}
        />
        <div className="flex rounded-lg border border-border bg-card">
          {TIME_RANGES.map((range) => (
            <button
              type="button"
              key={range.value}
              onClick={() => setTimeRange(range.value)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                timeRange === range.value
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </PageToolbar>

      {hasError && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to load agent analytics. Please try refreshing.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading agent analytics...
        </div>
      ) : hasError ? null : isEmpty ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-card/40 py-16 text-center">
          <Bot className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm font-medium text-foreground">No agent activity yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Agent sessions appear here once your collector syncs Claude or Codex transcripts for
            this time range.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {summary && <AgentKpiCards summary={summary} />}

          <div className="rounded-xl bg-card/40 p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MetricIcon className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-medium text-foreground">
                  {AGENT_METRIC_LABEL[metric]} Over Time
                </h2>
                {metric === 'cost' && (
                  <span
                    className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                    title="Agent Session Authoring Cost is an API-equivalent estimate, not provider spend. Some sources (notably Cursor) report only partial economics."
                  >
                    Estimated
                  </span>
                )}
              </div>
              <div className="flex rounded-lg border border-border bg-background">
                {AGENT_METRICS.map((m) => (
                  <button
                    type="button"
                    key={m}
                    onClick={() => selectMetric(m)}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      metric === m
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {AGENT_METRIC_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Group by</span>
                <div className="flex rounded-lg border border-border bg-background">
                  {AGENT_GROUP_BY.map((g) => (
                    <button
                      type="button"
                      key={g}
                      disabled={isGroupDisabled(g)}
                      onClick={() => setGroupBy(g)}
                      title={
                        isGroupDisabled(g) ? 'Tool events are not attributed to a model' : undefined
                      }
                      className={`px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        groupBy === g
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {AGENT_GROUP_BY_LABEL[g]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Bucket</span>
                  <div className="flex rounded-lg border border-border bg-background">
                    {AGENT_GRANULARITIES.map((g) => (
                      <button
                        type="button"
                        key={g}
                        onClick={() => setGranularity(g)}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          granularity === g
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {AGENT_GRANULARITY_LABEL[g]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex rounded-lg border border-border bg-background">
                  {(['stacked', 'line'] as AgentChartStyle[]).map((s) => (
                    <button
                      type="button"
                      key={s}
                      onClick={() => setChartStyle(s)}
                      className={`px-3 py-1 text-xs font-medium capitalize transition-colors ${
                        chartStyle === s
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <AgentUsageChart
              data={timeseries}
              metric={metric}
              groupBy={groupBy}
              chartStyle={chartStyle}
              onGroupClick={onGroupClick}
              labelFor={labelFor}
            />
          </div>

          <AgentBreakdownPanels
            filterParams={filterParams}
            metric={metric}
            labelFor={labelFor}
            selectedFor={breakdownSelected}
            onToggle={breakdownToggle}
          />

          <AgentSessionsTable filterParams={filterParams} repoLabelMap={repoLabelMap} />

          <div className="space-y-4">
            <h2 className="text-base font-medium text-foreground">Tool reliability</h2>
            <FailureLeaderboardTable data={failures} />
            <ToolDeltaTable data={deltas} />
          </div>
        </div>
      )}
    </div>
  );
}
