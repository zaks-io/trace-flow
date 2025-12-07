'use client';

import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { Layers } from 'lucide-react';
import { AlertIndicator } from '@/components/alerts';

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

function formatDuration(nanoseconds: number) {
  const milliseconds = nanoseconds / 1_000_000;
  if (milliseconds < 1) {
    return `${(milliseconds * 1000).toFixed(0)}μs`;
  }
  if (milliseconds < 1000) {
    return `${milliseconds.toFixed(1)}ms`;
  }
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function truncateId(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

export const spanGroupColumns: ColumnDef<SpanGroupRow>[] = [
  {
    id: 'alerts',
    header: '',
    size: 40,
    minSize: 40,
    maxSize: 40,
    cell: ({ row, table }) => {
      const alertSummary = table.options.meta?.alertSummary;
      const key = row.original.TraceId;
      const summary = alertSummary?.get(key);
      const hasAlerts = summary && summary.triggeredAlerts.length > 0;
      // Always render container to prevent layout reflow when alerts load
      return (
        <div className="flex h-5 w-8 items-center justify-center">
          {hasAlerts && <AlertIndicator triggeredAlerts={summary.triggeredAlerts} />}
        </div>
      );
    },
    meta: { category: 'alerts' as const, label: 'Alerts' },
    enableHiding: false,
  },
  {
    id: 'latestReceivedAt',
    accessorKey: 'LatestReceivedAt',
    header: 'Latest Activity',
    cell: ({ getValue }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatTimestamp(getValue<number>())}
      </span>
    ),
    meta: { category: 'standard', label: 'Latest Activity' },
  },
  {
    id: 'traceId',
    accessorKey: 'TraceId',
    header: 'Trace ID',
    cell: ({ getValue }) => {
      const value = getValue<string>();
      return (
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-purple-400" />
          <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs" title={value}>
            {truncateId(value)}
          </code>
        </div>
      );
    },
    meta: { category: 'standard', label: 'Trace ID' },
  },
  {
    id: 'childSpanCount',
    accessorKey: 'ChildSpanCount',
    header: 'Requests',
    cell: ({ getValue }) => {
      const count = getValue<number>();
      return (
        <span className="inline-flex items-center rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-400">
          {count} {count === 1 ? 'request' : 'requests'}
        </span>
      );
    },
    meta: { category: 'standard', label: 'Request Count' },
  },
  {
    id: 'models',
    accessorKey: 'Models',
    header: 'Models',
    cell: ({ getValue }) => {
      const models = getValue<string[]>().filter(Boolean);
      if (models.length === 0) {
        return <span className="text-muted-foreground/40">—</span>;
      }
      if (models.length === 1) {
        return (
          <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">{models[0]}</code>
        );
      }
      return (
        <div className="flex items-center gap-1">
          <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">{models[0]}</code>
          <span className="text-xs text-muted-foreground">+{models.length - 1}</span>
        </div>
      );
    },
    meta: { category: 'ai', label: 'Models' },
  },
  {
    id: 'avgDuration',
    accessorKey: 'AvgDuration',
    header: 'Avg Duration',
    cell: ({ getValue }) => (
      <span className="font-mono text-sm tabular-nums">{formatDuration(getValue<number>())}</span>
    ),
    meta: { category: 'standard', label: 'Avg Duration' },
  },
  {
    id: 'totalDuration',
    accessorKey: 'TotalDuration',
    header: 'Total Duration',
    cell: ({ getValue }) => (
      <span className="font-mono text-sm tabular-nums text-muted-foreground">
        {formatDuration(getValue<number>())}
      </span>
    ),
    meta: { category: 'standard', label: 'Total Duration' },
  },
  {
    id: 'errorCount',
    accessorKey: 'ErrorCount',
    header: 'Errors',
    cell: ({ getValue }) => {
      const count = getValue<number>();
      if (count === 0) {
        return <span className="text-muted-foreground/40">—</span>;
      }
      return (
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            'bg-red-500/20 text-red-400',
          )}
        >
          {count} {count === 1 ? 'error' : 'errors'}
        </span>
      );
    },
    meta: { category: 'standard', label: 'Errors' },
  },
];

export const defaultSpanGroupColumnVisibility: VisibilityState = {
  latestReceivedAt: true,
  traceId: true,
  childSpanCount: true,
  models: true,
  avgDuration: true,
  totalDuration: false,
  errorCount: true,
};
