'use client';

import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TinybirdResponse } from '@/components/usage/types';
import { rankBreakdown } from './breakdown';
import {
  AGENT_BREAKDOWN_DIMENSIONS,
  AGENT_GROUP_COLORS,
  type AgentBreakdownDimension,
  type AgentBreakdownRow,
} from './types';

/** Cost/tokens/messages/sessions all exist on AgentBreakdownRow; tool-events has no breakdown grain. */
type ContextBarMetric = 'cost' | 'tokens' | 'messages' | 'sessions';

const METRIC_KEY: Record<ContextBarMetric, keyof AgentBreakdownRow> = {
  cost: 'cost_usd',
  tokens: 'total_tokens',
  messages: 'message_count',
  sessions: 'session_count',
};

const METRIC_LABEL: Record<ContextBarMetric, string> = {
  cost: 'Cost',
  tokens: 'Tokens',
  messages: 'Messages',
  sessions: 'Sessions',
};

const DIMENSION_LABEL: Record<AgentBreakdownDimension, string> = {
  source: 'Source',
  model: 'Model',
  repo: 'Repo',
};

const METRICS: ContextBarMetric[] = ['cost', 'tokens', 'messages', 'sessions'];

const BREAKDOWN_LIMIT = 10;

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  label,
  optionLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  optionLabel: (v: T) => string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex rounded-lg border border-border bg-background">
        {options.map((option) => (
          <button
            type="button"
            key={option}
            onClick={() => onChange(option)}
            className={cn(
              'px-2.5 py-1 text-xs font-medium transition-colors',
              value === option
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {optionLabel(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A horizontal stacked proportional bar showing where the selected metric comes from across
 * a dimension for the Overview summary. Segments cross-filter the page.
 */
export function ContextBar({
  filterParams,
  labelFor,
  selectedFor,
  onToggle,
  defaultDimension = 'repo',
}: {
  filterParams: Record<string, string | number>;
  labelFor: (value: string) => string;
  selectedFor: (dimension: AgentBreakdownDimension) => string[];
  onToggle: (dimension: AgentBreakdownDimension, value: string) => void;
  defaultDimension?: AgentBreakdownDimension;
}) {
  const [metric, setMetric] = useState<ContextBarMetric>('cost');
  const [dimension, setDimension] = useState<AgentBreakdownDimension>(defaultDimension);
  const metricKey = METRIC_KEY[metric];
  const isCurrency = metric === 'cost';

  const query = useTinybirdQuery<TinybirdResponse<AgentBreakdownRow>>({
    pipe: 'agent_usage_breakdown',
    params: { ...filterParams, dimension, order_by: metricKey, limit: BREAKDOWN_LIMIT },
  });

  const segments = useMemo(() => {
    const rows = query.data?.data ?? [];
    return rankBreakdown(rows, metricKey)
      .slice(0, BREAKDOWN_LIMIT)
      .filter((entry) => entry.amount > 0);
  }, [query.data, metricKey]);

  const total = segments.reduce((sum, entry) => sum + entry.amount, 0);
  const format = (v: number) => (isCurrency ? formatCurrency(v) : formatNumber(v));
  const selected = selectedFor(dimension);

  return (
    <div className="rounded-xl bg-card/40 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium text-foreground">
            Top {BREAKDOWN_LIMIT} {METRIC_LABEL[metric].toLowerCase()} by{' '}
            {DIMENSION_LABEL[dimension].toLowerCase()}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            label="Break down"
            options={AGENT_BREAKDOWN_DIMENSIONS}
            value={dimension}
            onChange={setDimension}
            optionLabel={(d) => DIMENSION_LABEL[d]}
          />
          <ToggleGroup
            label="Metric"
            options={METRICS}
            value={metric}
            onChange={setMetric}
            optionLabel={(m) => METRIC_LABEL[m]}
          />
        </div>
      </div>

      {query.isLoading && !query.data ? (
        <p className="text-sm text-muted-foreground">Loading breakdown...</p>
      ) : query.error ? (
        <p className="text-sm text-destructive">Could not load breakdown</p>
      ) : segments.length === 0 || total === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {METRIC_LABEL[metric].toLowerCase()} in this range
        </p>
      ) : (
        <>
          <div className="flex h-3 w-full gap-px overflow-hidden rounded-md bg-muted/40">
            {segments.map((entry, i) => {
              const label = labelFor(entry.value);
              const share = entry.amount / total;
              const isSelected = selected.includes(entry.value);
              return (
                <button
                  type="button"
                  key={entry.value}
                  onClick={() => onToggle(dimension, entry.value)}
                  title={`${label}: ${format(entry.amount)} (${formatPercent(
                    share * 100,
                  )} of visible top ${BREAKDOWN_LIMIT})`}
                  style={{
                    width: `${share * 100}%`,
                    backgroundColor: AGENT_GROUP_COLORS[i % AGENT_GROUP_COLORS.length],
                  }}
                  className={cn(
                    'h-full min-w-[2px] transition-all',
                    'cursor-pointer hover:brightness-110',
                    isSelected && 'ring-1 ring-inset ring-primary brightness-110',
                  )}
                />
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {segments.map((entry, i) => {
              const label = labelFor(entry.value);
              const isSelected = selected.includes(entry.value);
              return (
                <button
                  type="button"
                  key={entry.value}
                  onClick={() => onToggle(dimension, entry.value)}
                  title={`${label}: ${format(entry.amount)} (${formatPercent(
                    (entry.amount / total) * 100,
                  )} of visible top ${BREAKDOWN_LIMIT})`}
                  className="flex cursor-pointer items-center gap-1.5 text-xs hover:text-foreground"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: AGENT_GROUP_COLORS[i % AGENT_GROUP_COLORS.length] }}
                  />
                  <span
                    className={cn(
                      'max-w-[14rem] truncate',
                      isSelected ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {label}
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {format(entry.amount)} ({formatPercent((entry.amount / total) * 100)})
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
