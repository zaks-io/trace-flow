'use client';

import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { formatCurrency, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TinybirdResponse } from '@/components/usage/types';
import { OTHER_GROUP, OTHER_LABEL } from './pivot';
import { rankBreakdown } from './breakdown';
import {
  AGENT_BREAKDOWN_DIMENSIONS,
  AGENT_BREAKDOWN_METRIC_KEY,
  REPO_TOP_N,
  type AgentBreakdownDimension,
  type AgentBreakdownRow,
  type AgentMetric,
} from './types';

const DIMENSION_TITLE: Record<AgentBreakdownDimension, string> = {
  source: 'By Source',
  model: 'By Model',
  repo: 'By Repo',
};

// The breakdown has no tool grain, so the tool-events metric ranks by messages.
const RANK_LABEL: Record<AgentMetric, string> = {
  cost: 'estimated cost',
  tokens: 'tokens',
  messages: 'messages',
  sessions: 'sessions',
  'tool-events': 'messages',
};

function AgentBreakdownPanel({
  dimension,
  filterParams,
  metric,
  labelFor,
  selected,
  onToggle,
}: {
  dimension: AgentBreakdownDimension;
  filterParams: Record<string, string | number>;
  metric: AgentMetric;
  labelFor: (value: string) => string;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const metricKey = AGENT_BREAKDOWN_METRIC_KEY[metric];

  const query = useTinybirdQuery<TinybirdResponse<AgentBreakdownRow>>({
    pipe: 'agent_usage_breakdown',
    // order_by matches the client ranking so the pipe's LIMIT keeps the right rows.
    params: { ...filterParams, dimension, order_by: metricKey, limit: 100 },
  });
  const isCurrency = metric === 'cost';

  const entries = useMemo(() => {
    const rows = query.data?.data ?? [];
    return rankBreakdown(rows, metricKey, dimension === 'repo' ? REPO_TOP_N : undefined);
  }, [query.data, metricKey, dimension]);

  const max = entries.reduce((m, e) => Math.max(m, e.amount), 0);
  const format = (v: number) => (isCurrency ? formatCurrency(v) : formatNumber(v));

  return (
    <div className="rounded-xl bg-card/40 p-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-foreground">{DIMENSION_TITLE[dimension]}</h3>
        <span className="text-xs text-muted-foreground">by {RANK_LABEL[metric]}</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data</p>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => {
            const isOther = entry.value === OTHER_GROUP;
            const isSelected = selected.includes(entry.value);
            const label = isOther ? OTHER_LABEL : labelFor(entry.value);
            return (
              <button
                key={entry.value}
                type="button"
                disabled={isOther}
                onClick={() => onToggle(entry.value)}
                title={isOther ? 'Aggregated lower-ranked repos; not filterable' : label}
                className={cn(
                  'group relative block w-full overflow-hidden rounded-md px-2 py-1.5 text-left transition-colors',
                  isOther ? 'cursor-default' : 'hover:bg-muted/40',
                  isSelected && 'bg-primary/10',
                )}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-md bg-primary/10"
                  style={{ width: max > 0 ? `${(entry.amount / max) * 100}%` : '0%' }}
                />
                <span className="relative flex items-center justify-between gap-2 text-xs">
                  <span className={cn('truncate', isSelected ? 'text-primary' : 'text-foreground')}>
                    {label}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    {format(entry.amount)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AgentBreakdownPanels({
  filterParams,
  metric,
  labelFor,
  selectedFor,
  onToggle,
}: {
  filterParams: Record<string, string | number>;
  metric: AgentMetric;
  labelFor: (value: string) => string;
  selectedFor: (dimension: AgentBreakdownDimension) => string[];
  onToggle: (dimension: AgentBreakdownDimension, value: string) => void;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {AGENT_BREAKDOWN_DIMENSIONS.map((dimension) => (
        <AgentBreakdownPanel
          key={dimension}
          dimension={dimension}
          filterParams={filterParams}
          metric={metric}
          labelFor={labelFor}
          selected={selectedFor(dimension)}
          onToggle={(value) => onToggle(dimension, value)}
        />
      ))}
    </div>
  );
}
