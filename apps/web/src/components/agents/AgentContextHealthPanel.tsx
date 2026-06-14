'use client';

import { useMemo } from 'react';
import { Gauge } from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TinybirdResponse } from '@/components/usage/types';
import { AgentSection, AgentTableEmpty } from './AgentSection';
import { buildContextHealthParams, contextHealthBand, formatContextTokens } from './contextHealth';
import {
  AGENT_CONTEXT_BREAKDOWN_DIMENSIONS,
  type AgentContextBreakdownDimension,
  type AgentContextHealthRow,
} from './types';

const DIMENSION_TITLE: Record<AgentContextBreakdownDimension, string> = {
  source: 'By Source',
  model: 'By Model',
  repo: 'By Repo',
};

function MetricCell({
  label,
  value,
  prior,
  title,
}: {
  label: string;
  value: string;
  prior: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 py-2" title={title}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-xl font-semibold tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">prior {prior}</p>
    </div>
  );
}

function ContextBreakdownPanel({
  dimension,
  filterParams,
  models,
  attentionThresholdTokens,
  labelFor,
  selected,
  onToggle,
}: {
  dimension: AgentContextBreakdownDimension;
  filterParams: Record<string, string | number>;
  models: string[];
  attentionThresholdTokens: number;
  labelFor: (value: string) => string;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const params = useMemo(
    () =>
      buildContextHealthParams({
        filterParams,
        models,
        attentionThresholdTokens,
        dimension,
        limit: 100,
      }),
    [attentionThresholdTokens, dimension, filterParams, models],
  );

  const query = useTinybirdQuery<TinybirdResponse<AgentContextHealthRow>>({
    pipe: 'agent_context_health',
    params,
  });

  const rows = useMemo(
    () => (query.data?.data ?? []).filter((row) => row.group_value.length > 0),
    [query.data],
  );
  const max = rows.reduce((value, row) => Math.max(value, row.context_overage_tokens), 0);

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{DIMENSION_TITLE[dimension]}</h3>
        <span className="text-xs text-muted-foreground">by overage</span>
      </div>
      {query.isLoading && !query.data ? (
        <p className="text-sm text-muted-foreground">Loading context data...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No measured context data</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => {
            const label = dimension === 'repo' ? labelFor(row.group_value) : row.group_value;
            const isSelected = selected.includes(row.group_value);
            return (
              <button
                key={row.group_value}
                type="button"
                onClick={() => onToggle(row.group_value)}
                title={label}
                className={cn(
                  'group relative block w-full overflow-hidden rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/40',
                  isSelected && 'bg-primary/10',
                )}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-md bg-primary/10"
                  style={{ width: max > 0 ? `${(row.context_overage_tokens / max) * 100}%` : '0%' }}
                />
                <span className="relative flex items-center justify-between gap-2 text-xs">
                  <span className={cn('truncate', isSelected ? 'text-primary' : 'text-foreground')}>
                    {label}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    {formatContextTokens(row.context_overage_tokens)}
                  </span>
                </span>
                <span className="relative mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>{formatPercent(row.pct_calls_over_threshold * 100)} calls pressured</span>
                  <span>floor {formatNumber(row.first_call_context_p50)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AgentContextHealthPanel({
  row,
  filterParams,
  models,
  attentionThresholdTokens,
  labelFor,
  selectedFor,
  onToggle,
}: {
  row: AgentContextHealthRow | null;
  filterParams: Record<string, string | number>;
  models: string[];
  attentionThresholdTokens: number;
  labelFor: (value: string) => string;
  selectedFor: (dimension: AgentContextBreakdownDimension) => string[];
  onToggle: (dimension: AgentContextBreakdownDimension, value: string) => void;
}) {
  const band = contextHealthBand(row);

  return (
    <AgentSection
      icon={Gauge}
      title="Context Health"
      subtitle="Startup context floor and over-threshold burden. Directional only."
      count={row?.model_call_count ?? 0}
      countLabel="measured calls"
    >
      {band === 'empty' || !row ? (
        <AgentTableEmpty message="No measured context data for this range." />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-x-8 gap-y-3 border-y border-border py-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCell
              label="Startup Floor"
              value={formatContextTokens(row.first_call_context_p50)}
              prior={formatContextTokens(row.prior_first_call_context_p50)}
              title="Median context tokens on the first measured assistant call in each session."
            />
            <MetricCell
              label="Attention Pressure"
              value={`${formatPercent(row.pct_calls_over_threshold * 100)} calls`}
              prior={`${formatPercent(row.prior_pct_calls_over_threshold * 100)} calls`}
              title={`Calls above ${formatNumber(attentionThresholdTokens)} context tokens.`}
            />
            <MetricCell
              label="Overage Burden"
              value={formatContextTokens(row.context_overage_tokens)}
              prior={formatContextTokens(row.prior_context_overage_tokens)}
              title="Total context tokens above the configured threshold."
            />
            <MetricCell
              label="Pressured Cost"
              value={formatCurrency(row.cost_while_over_threshold)}
              prior={formatCurrency(row.prior_cost_while_over_threshold)}
              title="Estimated cost from measured calls above the configured threshold."
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            {AGENT_CONTEXT_BREAKDOWN_DIMENSIONS.map((dimension) => (
              <ContextBreakdownPanel
                key={dimension}
                dimension={dimension}
                filterParams={filterParams}
                models={models}
                attentionThresholdTokens={attentionThresholdTokens}
                labelFor={labelFor}
                selected={selectedFor(dimension)}
                onToggle={(value) => onToggle(dimension, value)}
              />
            ))}
          </div>
        </div>
      )}
    </AgentSection>
  );
}
