'use client';

import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { GitBranch } from 'lucide-react';

export interface SpanRow {
  ReceivedAt: number;
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
  SpanAttributes: string;
}

function getSpanAttribute(row: SpanRow, key: string): string | undefined {
  try {
    const attrs = JSON.parse(row.SpanAttributes) as Record<string, string>;
    return attrs[key];
  } catch {
    return undefined;
  }
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
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function getSpanTypeColor(spanName: string): string {
  const name = spanName.toLowerCase();
  if (name === 'ai.request' || name.includes('chat/completions'))
    return 'bg-purple-500/20 text-purple-400';
  if (name.startsWith('ai.response.')) return 'bg-blue-500/20 text-blue-400';
  if (name.includes('tool')) return 'bg-orange-500/20 text-orange-400';
  if (name.startsWith('ai.request.')) return 'bg-emerald-500/20 text-emerald-400';
  return 'bg-zinc-500/20 text-zinc-400';
}

export const spanColumns: ColumnDef<SpanRow>[] = [
  {
    id: 'receivedAt',
    accessorKey: 'ReceivedAt',
    header: 'Received',
    cell: ({ getValue }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatTimestamp(getValue<number>())}
      </span>
    ),
    meta: { category: 'standard', label: 'Received' },
  },
  {
    id: 'spanName',
    accessorKey: 'SpanName',
    header: 'Span Name',
    cell: ({ getValue }) => {
      const value = getValue<string>();
      return (
        <div className="flex items-center gap-2">
          <span
            className={cn('rounded-md px-1.5 py-0.5 text-xs font-medium', getSpanTypeColor(value))}
          >
            {value.split('.').pop() ?? value}
          </span>
          <span className="font-medium text-foreground" title={value}>
            {value}
          </span>
        </div>
      );
    },
    meta: { category: 'standard', label: 'Span Name' },
  },
  {
    id: 'traceId',
    accessorKey: 'TraceId',
    header: 'Trace',
    cell: ({ getValue }) => {
      const value = getValue<string>();
      return (
        <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs" title={value}>
          {truncateId(value)}
        </code>
      );
    },
    meta: { category: 'standard', label: 'Trace ID' },
  },
  {
    id: 'parentSpanId',
    accessorKey: 'ParentSpanId',
    header: 'Parent',
    cell: ({ getValue }) => {
      const value = getValue<string>();
      if (!value) {
        return (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <GitBranch className="h-3 w-3" />
            root
          </span>
        );
      }
      return (
        <code
          className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
          title={value}
        >
          {truncateId(value)}
        </code>
      );
    },
    meta: { category: 'standard', label: 'Parent Span' },
  },
  {
    id: 'aiProvider',
    accessorFn: (row) => getSpanAttribute(row, 'ai.provider'),
    header: 'Provider',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="text-muted-foreground">{value}</span>
      ) : (
        <span className="text-muted-foreground/40">—</span>
      );
    },
    meta: { category: 'ai', label: 'Provider' },
  },
  {
    id: 'aiModel',
    accessorFn: (row) => getSpanAttribute(row, 'ai.model'),
    header: 'Model',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">{value}</code>
      ) : (
        <span className="text-muted-foreground/40">—</span>
      );
    },
    meta: { category: 'ai', label: 'Model' },
  },
  {
    id: 'duration',
    accessorKey: 'Duration',
    header: 'Duration',
    cell: ({ getValue }) => (
      <span className="font-mono text-sm tabular-nums">{formatDuration(getValue<number>())}</span>
    ),
    meta: { category: 'standard', label: 'Duration' },
  },
  {
    id: 'statusCode',
    accessorKey: 'StatusCode',
    header: 'Status',
    cell: ({ getValue }) => {
      const status = getValue<string>();
      return (
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            status === 'OK' || status === 'UNSET'
              ? 'bg-emerald-500/20 text-emerald-400'
              : status === 'ERROR'
                ? 'bg-red-500/20 text-red-400'
                : 'bg-muted text-muted-foreground',
          )}
        >
          {status}
        </span>
      );
    },
    meta: { category: 'standard', label: 'Status' },
  },
  {
    id: 'serviceName',
    accessorKey: 'ServiceName',
    header: 'Service',
    cell: ({ getValue }) => <span className="text-muted-foreground">{getValue<string>()}</span>,
    meta: { category: 'standard', label: 'Service' },
  },
];

export const defaultSpanColumnVisibility: VisibilityState = {
  receivedAt: true,
  spanName: true,
  traceId: true,
  parentSpanId: false,
  aiProvider: true,
  aiModel: true,
  duration: true,
  statusCode: true,
  serviceName: false,
};
