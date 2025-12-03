'use client';

import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import { cn } from '@/lib/utils';

export interface RequestRow {
  ReceivedAt: number;
  Timestamp: number;
  TraceId: string;
  SpanId: string;
  SpanName: string;
  ServiceName: string;
  Duration: number;
  StatusCode: string;
  SpanAttributes: string;
}

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    category: 'standard' | 'llm' | 'http';
    label: string;
  }
}

function getSpanAttribute(row: RequestRow, key: string): string | undefined {
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
  return `${milliseconds.toFixed(2)}ms`;
}

function truncateId(id: string) {
  return id.length > 16 ? `${id.slice(0, 16)}...` : id;
}

export const allColumns: ColumnDef<RequestRow>[] = [
  {
    id: 'receivedAt',
    accessorKey: 'ReceivedAt',
    header: 'Received',
    cell: ({ getValue }) => formatTimestamp(getValue<number>()),
    meta: { category: 'standard', label: 'Received' },
  },
  {
    id: 'traceId',
    accessorKey: 'TraceId',
    header: 'Trace ID',
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
    id: 'spanName',
    accessorKey: 'SpanName',
    header: 'Request Name',
    cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
    meta: { category: 'standard', label: 'Request Name' },
  },
  {
    id: 'llmProvider',
    accessorFn: (row) => getSpanAttribute(row, 'llm.provider'),
    header: 'Provider',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="text-muted-foreground">{value}</span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'llm', label: 'Provider' },
  },
  {
    id: 'llmModel',
    accessorFn: (row) => getSpanAttribute(row, 'llm.model'),
    header: 'Model',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">{value}</code>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'llm', label: 'Model' },
  },
  {
    id: 'httpStatusCode',
    accessorFn: (row) => getSpanAttribute(row, 'http.status_code'),
    header: 'HTTP',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      if (!value) return <span className="text-muted-foreground/50">-</span>;

      const statusNum = parseInt(value, 10);
      return (
        <span
          className={cn(
            'font-mono text-xs',
            statusNum >= 200 && statusNum < 300 && 'text-emerald-400',
            statusNum >= 400 && statusNum < 500 && 'text-amber-400',
            statusNum >= 500 && 'text-destructive',
          )}
        >
          {value}
        </span>
      );
    },
    meta: { category: 'http', label: 'HTTP Status' },
  },
  {
    id: 'duration',
    accessorKey: 'Duration',
    header: 'Duration',
    cell: ({ getValue }) => (
      <span className="font-mono text-sm">{formatDuration(getValue<number>())}</span>
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
                ? 'bg-destructive/20 text-destructive'
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
  {
    id: 'totalTokens',
    accessorFn: (row) => getSpanAttribute(row, 'llm.usage.total_tokens'),
    header: 'Tokens',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="font-mono text-sm">{value}</span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'llm', label: 'Total Tokens' },
  },
  {
    id: 'promptTokens',
    accessorFn: (row) => getSpanAttribute(row, 'llm.usage.prompt_tokens'),
    header: 'Prompt',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="font-mono text-sm">{value}</span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'llm', label: 'Prompt Tokens' },
  },
  {
    id: 'completionTokens',
    accessorFn: (row) => getSpanAttribute(row, 'llm.usage.completion_tokens'),
    header: 'Completion',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="font-mono text-sm">{value}</span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'llm', label: 'Completion Tokens' },
  },
];

export const defaultColumnVisibility: VisibilityState = {
  receivedAt: true,
  traceId: true,
  spanName: true,
  llmProvider: true,
  llmModel: true,
  httpStatusCode: true,
  duration: true,
  statusCode: true,
  serviceName: false,
  totalTokens: false,
  promptTokens: false,
  completionTokens: false,
};
