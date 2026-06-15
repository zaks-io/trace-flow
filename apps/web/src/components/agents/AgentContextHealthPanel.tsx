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

const BREAKDOWN_LIMIT = 10;

function formatRatio(value: number): string {
  return formatPercent(value * 100);
}

function formatExactNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

function thresholdText(attentionThresholdTokens: number): string {
  return formatExactNumber(attentionThresholdTokens);
}

function MetricCell({
  label,
  value,
  detail,
  prior,
  title,
}: {
  label: string;
  value: string;
  detail: string;
  prior: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 py-2" title={title}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 break-words font-mono text-lg font-semibold leading-tight tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      <p className="mt-1 text-xs text-muted-foreground">prior {prior}</p>
    </div>
  );
}

function StartThresholdStat({
  label,
  sessions,
  priorSessions,
  pct,
  priorPct,
  totalSessions,
}: {
  label: string;
  sessions: number;
  priorSessions: number;
  pct: number;
  priorPct: number;
  totalSessions: number;
}) {
  return (
    <div className="min-w-0 border-t border-border py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">
        {formatNumber(sessions)} / {formatNumber(totalSessions)} conversations
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {`${formatRatio(pct)} of conversations; prior ${formatNumber(priorSessions)} (${formatRatio(
          priorPct,
        )})`}
      </p>
    </div>
  );
}

function FirstCallStartStats({ row }: { row: AgentContextHealthRow }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">
          Are new conversations starting bloated?
        </h3>
        <span className="text-xs text-muted-foreground">
          first model request in each conversation
        </span>
      </div>
      <div className="grid gap-x-8 sm:grid-cols-3">
        <StartThresholdStat
          label="Start size >= 25K"
          sessions={row.bloated_start_25k_sessions}
          priorSessions={row.prior_bloated_start_25k_sessions}
          pct={row.pct_bloated_start_25k}
          priorPct={row.prior_pct_bloated_start_25k}
          totalSessions={row.session_count}
        />
        <StartThresholdStat
          label="Start size >= 50K"
          sessions={row.bloated_start_50k_sessions}
          priorSessions={row.prior_bloated_start_50k_sessions}
          pct={row.pct_bloated_start_50k}
          priorPct={row.prior_pct_bloated_start_50k}
          totalSessions={row.session_count}
        />
        <StartThresholdStat
          label="Start size >= 100K"
          sessions={row.bloated_start_100k_sessions}
          priorSessions={row.prior_bloated_start_100k_sessions}
          pct={row.pct_bloated_start_100k}
          priorPct={row.prior_pct_bloated_start_100k}
          totalSessions={row.session_count}
        />
      </div>
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
        limit: BREAKDOWN_LIMIT,
      }),
    [attentionThresholdTokens, dimension, filterParams, models],
  );

  const query = useTinybirdQuery<TinybirdResponse<AgentContextHealthRow>>({
    pipe: 'agent_context_health',
    params,
  });

  const rows = useMemo(
    () =>
      (query.data?.data ?? []).filter(
        (row) =>
          row.group_value.length > 0 &&
          (row.calls_over_threshold > 0 ||
            row.sessions_over_threshold > 0 ||
            row.context_overage_tokens > 0),
      ),
    [query.data],
  );
  const max = rows.reduce((value, row) => Math.max(value, row.context_overage_tokens), 0);
  const threshold = thresholdText(attentionThresholdTokens);

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{DIMENSION_TITLE[dimension]}</h3>
        <span className="text-xs text-muted-foreground">
          top {BREAKDOWN_LIMIT} by tokens above {threshold}
        </span>
      </div>
      {query.isLoading && !query.data ? (
        <p className="text-sm text-muted-foreground">Loading context data...</p>
      ) : query.error ? (
        <p className="text-sm text-destructive">Could not load context breakdown</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No model requests over {threshold} tokens sent before the reply
        </p>
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
                    {formatContextTokens(row.context_overage_tokens)} above {threshold}
                  </span>
                </span>
                <span className="relative mt-1 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-[1fr_auto]">
                  <span>
                    {formatNumber(row.calls_over_threshold)} / {formatNumber(row.model_call_count)}{' '}
                    model requests over {threshold} ({formatRatio(row.pct_calls_over_threshold)})
                  </span>
                  <span>typical start {formatContextTokens(row.first_call_context_p50)}</span>
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
  error,
  filterParams,
  models,
  attentionThresholdTokens,
  labelFor,
  selectedFor,
  onToggle,
}: {
  row: AgentContextHealthRow | null;
  error?: Error | null;
  filterParams: Record<string, string | number>;
  models: string[];
  attentionThresholdTokens: number;
  labelFor: (value: string) => string;
  selectedFor: (dimension: AgentContextBreakdownDimension) => string[];
  onToggle: (dimension: AgentContextBreakdownDimension, value: string) => void;
}) {
  const band = contextHealthBand(row);
  const threshold = thresholdText(attentionThresholdTokens);
  const overThresholdRequestsPerConversation =
    row && row.sessions_over_threshold > 0
      ? row.calls_over_threshold / row.sessions_over_threshold
      : 0;
  const emptyValue = error ? 'Could not load' : 'No measured data';
  const emptyPrior = error ? 'not loaded' : 'no prior data';

  return (
    <AgentSection
      icon={Gauge}
      title="Conversation Size"
      subtitle={`Tokens sent to the model before it replies: input + cached context. Large-conversation threshold: ${threshold}.`}
      count={row?.model_call_count ?? 0}
      countLabel="model requests measured"
    >
      {band === 'empty' || !row ? (
        <div className="space-y-4">
          <div className="grid gap-x-8 gap-y-3 border-y border-border py-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCell
              label="How large do conversations start?"
              value={emptyValue}
              detail={
                error
                  ? 'First model request sizes were not loaded'
                  : 'No first model requests measured in this range'
              }
              prior={emptyPrior}
              title="Median tokens sent to the model on the first measured request in each conversation."
            />
            <MetricCell
              label={`How often do conversations cross ${threshold}?`}
              value={emptyValue}
              detail={
                error
                  ? `Requests over ${threshold} were not loaded`
                  : `No model requests measured over ${threshold}`
              }
              prior={emptyPrior}
              title={`Conversations and model requests above ${threshold} tokens sent before the reply.`}
            />
            <MetricCell
              label={`How long do they stay above ${threshold}?`}
              value={emptyValue}
              detail={
                error
                  ? `Tokens above ${threshold} were not loaded`
                  : `No tokens measured above ${threshold}`
              }
              prior={emptyPrior}
              title="Average model requests above the threshold for conversations that crossed it."
            />
            <MetricCell
              label={`What did requests above ${threshold} cost?`}
              value={emptyValue}
              detail={
                error
                  ? 'Estimated cost above the threshold was not loaded'
                  : 'No estimated cost from requests over the threshold'
              }
              prior={emptyPrior}
              title="Estimated total cost of measured model requests whose context exceeded the configured threshold."
            />
          </div>
          <AgentTableEmpty
            message={
              error
                ? 'Could not load conversation-size data for this range.'
                : 'No measured conversation-size data for this range.'
            }
          />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-x-8 gap-y-3 border-y border-border py-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCell
              label="How large do conversations start?"
              value={formatContextTokens(row.first_call_context_p50)}
              detail={`${formatNumber(row.session_count)} conversations, first model request only`}
              prior={`${formatContextTokens(row.prior_first_call_context_p50)} (${formatNumber(
                row.prior_session_count,
              )} conversations)`}
              title="Median tokens sent to the model on the first measured request in each conversation."
            />
            <MetricCell
              label={`How often do conversations cross ${threshold}?`}
              value={`${formatNumber(row.sessions_over_threshold)} / ${formatNumber(
                row.session_count,
              )} conversations`}
              detail={`${formatNumber(row.calls_over_threshold)} / ${formatNumber(
                row.model_call_count,
              )} model requests over ${threshold}`}
              prior={`${formatNumber(row.prior_sessions_over_threshold)} / ${formatNumber(
                row.prior_session_count,
              )} conversations (${formatRatio(row.prior_pct_sessions_over_threshold)})`}
              title={`Conversations and model requests above ${threshold} tokens sent before the reply.`}
            />
            <MetricCell
              label={`How long do they stay above ${threshold}?`}
              value={`${formatNumber(overThresholdRequestsPerConversation)} requests / crossed conversation`}
              detail={`${formatContextTokens(row.context_overage_tokens)} total tokens above ${threshold}`}
              prior={`${formatContextTokens(row.prior_context_overage_tokens)} above threshold`}
              title="Average model requests above the threshold for conversations that crossed it."
            />
            <MetricCell
              label={`What did requests above ${threshold} cost?`}
              value={formatCurrency(row.cost_while_over_threshold)}
              detail={`${formatContextTokens(
                row.output_tokens_while_over_threshold,
              )} output on requests over threshold`}
              prior={formatCurrency(row.prior_cost_while_over_threshold)}
              title="Estimated total cost of measured model requests whose context exceeded the configured threshold."
            />
          </div>

          <FirstCallStartStats row={row} />

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
