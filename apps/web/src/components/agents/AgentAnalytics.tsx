'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Bot, X } from 'lucide-react';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { TIME_RANGES } from '@/components/usage/types';
import { cn } from '@/lib/utils';
import { useRepoDirectory } from '@/hooks/useRepoDirectory';
import { useAgentFilters } from './useAgentFilters';
import { useAgentData } from './useAgentData';
import { AGENT_SOURCES } from './types';
import { MultiFilterDropdown } from './MultiFilterDropdown';
import { AgentBentoGrid } from './AgentBentoGrid';
import { resolveAttentionThreshold } from './contextHealth';
import {
  hasLoadedAgentData,
  hasLoadedAgentDetailData,
  shouldShowAgentEmptyState,
} from './agentAnalyticsState';

const DAY_MS = 24 * 60 * 60 * 1000;

export function AgentAnalytics() {
  const searchParams = useSearchParams();
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
    hasFilters,
    clearFilters,
    filterParams,
  } = useAgentFilters();
  const attentionThresholdTokens = useMemo(
    () => resolveAttentionThreshold(searchParams.get('attention_threshold_tokens')),
    [searchParams],
  );
  const {
    timeseries,
    burnSeries,
    priorBurnSeries,
    summary,
    costDistribution,
    notableTotal,
    notableByRepo,
    contextHealth,
    failures,
    deltas,
    isLoading,
    hasError,
    failedSurfaces,
    isEmpty,
    timezone,
  } = useAgentData({
    filterParams,
    groupBy,
    granularity: 'auto',
    models,
    attentionThresholdTokens,
  });

  // Resolve repo_fingerprint -> display name; loaded whenever there is data to show.
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
  // Guard on groupBy: the hero drill-down also groups by source/repo, whose group_values
  // are NOT models and would otherwise poison the Model filter list.
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
  }, [timeseries, groupBy]);
  const modelOptions = useMemo(() => {
    const set = new Set(seenModels);
    for (const m of models) set.add(m);
    return [...set];
  }, [seenModels, models]);

  const windowDays = Math.max(
    1,
    Math.round((Number(filterParams.end_time_ms) - Number(filterParams.start_time_ms)) / DAY_MS),
  );
  const hasAnyLoadedData = hasLoadedAgentData({
    summary,
    timeseries,
    contextHealth,
    failures,
    deltas,
  });
  const shouldShowEmptyState = shouldShowAgentEmptyState({
    isEmpty,
    hasError,
    hasLoadedData: hasAnyLoadedData,
    hasLoadedDetailData: hasLoadedAgentDetailData({ timeseries, contextHealth, failures, deltas }),
  });
  const failedSurfaceLabels =
    failedSurfaces.map((failure) => failure.label).join(', ') || 'one or more analytics sections';

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
        <div
          className={cn(
            'mb-6 rounded-lg border p-4 text-sm',
            hasAnyLoadedData
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              : 'border-red-500/30 bg-red-500/10 text-red-400',
          )}
        >
          {hasAnyLoadedData
            ? `Could not load: ${failedSurfaceLabels}. Loaded sections are still shown.`
            : 'Failed to load agent analytics. Please try refreshing.'}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading agent analytics...
        </div>
      ) : hasError && !hasAnyLoadedData ? null : shouldShowEmptyState || !summary ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-card/40 py-16 text-center">
          <Bot className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm font-medium text-foreground">No agent activity yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Agent sessions appear here once your collector syncs Claude or Codex transcripts for
            this time range.
          </p>
        </div>
      ) : (
        <AgentBentoGrid
          summary={summary}
          burnSeries={burnSeries}
          priorBurnSeries={priorBurnSeries}
          groupedSeries={timeseries}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          costDistribution={costDistribution}
          notableTotal={notableTotal}
          notableByRepo={notableByRepo}
          contextHealth={contextHealth}
          failures={failures}
          deltas={deltas}
          filterParams={filterParams}
          timezone={timezone}
          attentionThresholdTokens={attentionThresholdTokens}
          windowDays={windowDays}
          labelFor={labelFor}
        />
      )}
    </div>
  );
}
