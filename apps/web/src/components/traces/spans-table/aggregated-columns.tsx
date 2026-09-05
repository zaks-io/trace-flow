'use client';

import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import { AlertIndicator } from '@/components/alerts';
import { ModelPill } from './ModelPill';
import { formatRelativeTime } from '@/lib/format';
import { formatNumber, formatCurrency } from '@/lib/format';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { readAlertSummary } from '@/components/requests/data-table/metadata';

export interface SpanGroupRow {
  TraceId: string;
  ChildSpanCount: number;
  FirstTimestamp: number;
  LastTimestamp: number;
  LatestReceivedAt: number;
  TotalDuration: number;
  AvgDuration: number;
  MaxDuration: number;
  ErrorCount: number;
  Models: string[];
  Operations: string[];
  TotalTokens: number;
  PromptTokens: number;
  CompletionTokens: number;
  MaxTTFT: number;
  TotalCost: number;
}

function formatTimestamp(nanoseconds: number) {
  const milliseconds = nanoseconds / 1_000_000;
  return new Date(milliseconds).toLocaleString();
}

function formatDurationNs(nanoseconds: number) {
  const milliseconds = nanoseconds / 1_000_000;
  if (milliseconds < 1) {
    return `${(milliseconds * 1000).toFixed(0)}μs`;
  }
  if (milliseconds < 1000) {
    return `${milliseconds.toFixed(1)}ms`;
  }
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

const MAX_VISIBLE_MODELS = 3;

export const spanGroupColumns: ColumnDef<SpanGroupRow>[] = [
  {
    id: 'trace',
    header: 'Trace',
    cell: ({ row, table }) => {
      const { Models, Operations, ChildSpanCount, ErrorCount, TraceId } = row.original;
      const models = (Models ?? []).filter(Boolean);
      const operations = (Operations ?? []).filter(Boolean);

      const alertSummary = readAlertSummary(table.options.meta);
      const summary = alertSummary?.get(TraceId);
      const hasAlerts = summary && summary.triggeredAlerts.length > 0;

      const MAX_OPS = 3;
      const visibleOps = operations.slice(0, MAX_OPS);
      const remainingOps = operations.length - MAX_OPS;

      const visibleModels = models.slice(0, MAX_VISIBLE_MODELS);
      const remainingModels = models.length - MAX_VISIBLE_MODELS;

      return (
        <div className="flex items-start gap-3 py-0.5">
          <div className="flex h-10 w-5 shrink-0 items-center justify-center">
            {hasAlerts && <AlertIndicator triggeredAlerts={summary.triggeredAlerts} />}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* Line 1: Operations — primary scan target */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate text-sm font-medium text-foreground">
                {visibleOps.length > 0 ? (
                  <>
                    {visibleOps.join(', ')}
                    {remainingOps > 0 && (
                      <span className="text-muted-foreground font-normal"> +{remainingOps}</span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground/50 italic">unnamed</span>
                )}
              </span>
            </div>

            {/* Line 2: Models + request count + errors */}
            <div className="flex items-center gap-1.5 min-w-0">
              {models.length > 0 ? (
                <>
                  {visibleModels.map((model) => (
                    <ModelPill key={model} model={model} />
                  ))}
                  {remainingModels > 0 && (
                    <span className="text-[11px] text-muted-foreground">+{remainingModels}</span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground/40 text-[11px]">no model</span>
              )}

              <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 ml-1">
                {ChildSpanCount} {ChildSpanCount === 1 ? 'req' : 'reqs'}
              </span>

              {ErrorCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-400 shrink-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                  {ErrorCount} {ErrorCount === 1 ? 'error' : 'errors'}
                </span>
              )}
            </div>
          </div>
        </div>
      );
    },
    meta: { category: 'standard', label: 'Trace' },
    enableHiding: false,
  },
  {
    id: 'avgDuration',
    accessorKey: 'AvgDuration',
    header: 'Duration',
    size: 100,
    cell: ({ getValue }) => {
      const ns = getValue<number>();
      const ms = ns / 1_000_000;
      return (
        <span className={`font-mono text-sm tabular-nums ${ms > 5000 ? 'text-amber-400' : ''}`}>
          {formatDurationNs(ns)}
        </span>
      );
    },
    meta: { category: 'standard', label: 'Avg Duration' },
  },
  {
    id: 'totalTokens',
    accessorKey: 'TotalTokens',
    header: 'Tokens',
    size: 90,
    cell: ({ getValue }) => {
      const tokens = getValue<number>();
      if (!tokens) return <span className="text-muted-foreground/40">—</span>;
      return (
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {formatNumber(tokens)}
        </span>
      );
    },
    meta: { category: 'ai', label: 'Tokens' },
  },
  {
    id: 'totalCost',
    accessorKey: 'TotalCost',
    header: 'Cost',
    size: 80,
    cell: ({ getValue }) => {
      const cost = getValue<number>();
      if (!cost) return <span className="text-muted-foreground/40">—</span>;
      return (
        <span className="font-mono text-sm tabular-nums text-emerald-400">
          {formatCurrency(cost)}
        </span>
      );
    },
    meta: { category: 'ai', label: 'Cost' },
  },
  {
    id: 'latestReceivedAt',
    accessorKey: 'LatestReceivedAt',
    header: 'Time',
    size: 100,
    cell: ({ getValue }) => {
      const ns = getValue<number>();
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="tabular-nums text-muted-foreground text-sm cursor-default">
              {formatRelativeTime(ns)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">
            <span className="text-xs">{formatTimestamp(ns)}</span>
          </TooltipContent>
        </Tooltip>
      );
    },
    meta: { category: 'standard', label: 'Time' },
  },
  // Hidden columns still available in column toggle
  {
    id: 'totalDuration',
    accessorKey: 'TotalDuration',
    header: 'Total Duration',
    cell: ({ getValue }) => (
      <span className="font-mono text-sm tabular-nums text-muted-foreground">
        {formatDurationNs(getValue<number>())}
      </span>
    ),
    meta: { category: 'standard', label: 'Total Duration' },
  },
  {
    id: 'traceId',
    accessorKey: 'TraceId',
    header: 'Trace ID',
    cell: ({ getValue }) => {
      const value = getValue<string>();
      const truncated = value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
      return (
        <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs" title={value}>
          {truncated}
        </code>
      );
    },
    meta: { category: 'standard', label: 'Trace ID' },
  },
];

export const defaultSpanGroupColumnVisibility: VisibilityState = {
  trace: true,
  avgDuration: true,
  totalTokens: true,
  totalCost: true,
  latestReceivedAt: true,
  totalDuration: false,
  traceId: false,
};
