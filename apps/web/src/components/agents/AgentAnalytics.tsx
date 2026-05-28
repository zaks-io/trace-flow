'use client';

import { useState } from 'react';
import { Bot, DollarSign, Hash, MessageSquare, Wrench } from 'lucide-react';
import { PageToolbar } from '@/components/shared/PageToolbar';
import { FilterDropdown } from '@/components/usage/FilterDropdown';
import { TIME_RANGES } from '@/components/usage/types';
import { useAgentFilters } from './useAgentFilters';
import { useAgentData } from './useAgentData';
import {
  AGENT_SOURCES,
  AGENT_METRICS,
  AGENT_METRIC_CONFIG,
  AGENT_METRIC_LABEL,
  type AgentMetric,
  type AgentSource,
} from './types';
import { AgentUsageChart } from './AgentUsageChart';
import { CoverageHeader } from './CoverageHeader';
import { FailureLeaderboardTable } from './FailureLeaderboardTable';
import { ToolDeltaTable } from './ToolDeltaTable';
import { SessionOutliersTable } from './SessionOutliersTable';

const METRIC_ICON: Record<AgentMetric, React.ComponentType<{ className?: string }>> = {
  cost: DollarSign,
  tokens: Hash,
  messages: MessageSquare,
  sessions: Bot,
  'tool-events': Wrench,
};

export function AgentAnalytics() {
  const { timeRange, setTimeRange, source, setSource, filterParams } = useAgentFilters();
  const {
    timeseries,
    coverage,
    failures,
    deltas,
    outliers,
    isLoading,
    hasError,
    isEmpty,
    isPartial,
  } = useAgentData({ filterParams });
  const [metric, setMetric] = useState<AgentMetric>('cost');

  const MetricIcon = METRIC_ICON[metric];
  const legend = Object.entries(AGENT_METRIC_CONFIG[metric]);

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
        <FilterDropdown
          label="Source"
          value={source}
          options={[...AGENT_SOURCES]}
          onChange={(value) => setSource(value as AgentSource)}
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
                    onClick={() => setMetric(m)}
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
            {legend.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-3 text-xs">
                {legend.map(([key, cfg]) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: cfg.color }} />
                    <span className="text-muted-foreground">{String(cfg.label)}</span>
                  </span>
                ))}
              </div>
            )}
            <AgentUsageChart data={timeseries} metric={metric} />
          </div>

          {coverage && <CoverageHeader coverage={coverage} isPartial={isPartial} />}
          <FailureLeaderboardTable data={failures} />
          <ToolDeltaTable data={deltas} />
          <SessionOutliersTable data={outliers} />
        </div>
      )}
    </div>
  );
}
