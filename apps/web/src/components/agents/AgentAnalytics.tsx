'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Bot, X } from 'lucide-react';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { TIME_RANGES } from '@/components/usage/types';
import { cn } from '@/lib/utils';
import { useRepoDirectory } from '@/hooks/useRepoDirectory';
import { useAgentFilters } from './useAgentFilters';
import { useAgentData } from './useAgentData';
import { useAgentModelOptions } from './useAgentModelOptions';
import { AGENT_SOURCES, type AgentUsageGroupBy } from './types';
import { MultiFilterDropdown } from './MultiFilterDropdown';
import { AgentBentoGrid } from './AgentBentoGrid';
import { resolveAttentionThreshold } from './contextHealth';
import {
  hasLoadedAgentData,
  hasLoadedAgentDetailData,
  resolveAgentMainView,
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
  // The priciest-conversations fetch runs only while the spend-concentration cell is expanded.
  const [spendDetailOpen, setSpendDetailOpen] = useState(false);
  const [usageGroupBy, setUsageGroupBy] = useState<AgentUsageGroupBy>('repo');
  const {
    timeseries,
    burnSeries,
    priorBurnSeries,
    usageSeries,
    summary,
    costDistribution,
    costByDepth,
    reviewUnitCosts,
    topSessions,
    topSessionsLoading,
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
    usageGroupBy,
    models,
    attentionThresholdTokens,
    spendDetailEnabled: spendDetailOpen,
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

  const discoveredModels = useAgentModelOptions(filterParams);
  const modelOptions = useMemo(() => {
    const set = new Set(discoveredModels);
    for (const m of models) set.add(m);
    return [...set];
  }, [discoveredModels, models]);
  const toggleUsageGroup = useCallback(
    (value: string) => {
      if (usageGroupBy === 'model') toggleModel(value);
      else if (usageGroupBy === 'source') toggleSource(value);
      else toggleRepo(value);
    },
    [usageGroupBy, toggleModel, toggleRepo, toggleSource],
  );

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
  // A summary FAILURE leaves `summary` null without meaning the workspace is empty. The bento grid
  // needs a non-null summary, so it still can't render — but the empty state would lie ("No agent
  // activity yet") when other surfaces loaded and the toolbar already explains the summary failure.
  const summaryFailed = failedSurfaces.some((failure) => failure.id === 'summary');
  const mainView = resolveAgentMainView({
    isLoading,
    hasError: Boolean(hasError),
    hasAnyLoadedData,
    shouldShowEmptyState,
    hasSummary: Boolean(summary),
    summaryFailed,
  });

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

      {mainView === 'loading' ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading agent analytics...
        </div>
      ) : mainView === 'error' ? null : mainView === 'empty' || !summary ? (
        <div className="flex flex-col items-center gap-4 rounded-xl bg-card/40 px-6 py-16 text-center">
          <Bot className="h-10 w-10 text-muted-foreground/40" />
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              {hasFilters ? 'No agent activity for these filters' : 'No collector activity yet'}
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              Agent sessions appear here after Trace Flow Desktop syncs Claude Code, Codex CLI, or
              macOS Cursor activity for this time range.
            </p>
          </div>
          {!hasFilters ? (
            <>
              <div className="flex flex-wrap justify-center gap-3">
                <a
                  href="https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop.dmg"
                  className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Download for macOS
                </a>
                <a
                  href="https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop-setup.exe"
                  className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Download for Windows
                </a>
                <Link
                  href="/docs/collector"
                  className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Collector guide
                </Link>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <AgentBentoGrid
          summary={summary}
          burnSeries={burnSeries}
          priorBurnSeries={priorBurnSeries}
          groupedSeries={timeseries}
          usageSeries={usageSeries}
          usageGroupBy={usageGroupBy}
          onUsageGroupByChange={setUsageGroupBy}
          onUsageGroupToggle={toggleUsageGroup}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          costDistribution={costDistribution}
          costByDepth={costByDepth}
          reviewUnitCosts={reviewUnitCosts}
          topSessions={topSessions}
          topSessionsLoading={topSessionsLoading}
          onSpendDetailToggle={setSpendDetailOpen}
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
