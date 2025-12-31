'use client';

import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import { cn } from '@/lib/utils';
import { AlertIndicator } from '@/components/alerts';
import type { TraceAlertSummary } from '@/types/alerts';

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
    category: 'standard' | 'ai' | 'http' | 'alerts';
    label: string;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData> {
    alertSummary?: Map<string, TraceAlertSummary>;
  }
}

function getSpanAttribute(row: RequestRow, key: string): string | undefined {
  try {
    const attrs =
      typeof row.SpanAttributes === 'string'
        ? (JSON.parse(row.SpanAttributes) as Record<string, string>)
        : (row.SpanAttributes as unknown as Record<string, string>);
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
    meta: { category: 'alerts', label: 'Alerts' },
    enableHiding: false,
  },
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
    id: 'aiProvider',
    accessorFn: (row) => getSpanAttribute(row, 'gen_ai.system'),
    header: 'Provider',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="text-muted-foreground">{value}</span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'ai', label: 'Provider' },
  },
  {
    id: 'aiModel',
    accessorFn: (row) => getSpanAttribute(row, 'gen_ai.request.model'),
    header: 'Model',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">{value}</code>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'ai', label: 'Model' },
  },
  {
    id: 'httpStatusCode',
    accessorFn: (row) => getSpanAttribute(row, 'http.response.status_code'),
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
    accessorFn: (row) => {
      try {
        const attrs =
          typeof row.SpanAttributes === 'string'
            ? (JSON.parse(row.SpanAttributes) as Record<string, string>)
            : (row.SpanAttributes as unknown as Record<string, string>);
        const input = parseInt(attrs['gen_ai.usage.input_tokens'] ?? '0', 10) || 0;
        const output = parseInt(attrs['gen_ai.usage.output_tokens'] ?? '0', 10) || 0;
        return input + output > 0 ? String(input + output) : undefined;
      } catch {
        return undefined;
      }
    },
    header: 'Tokens',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="font-mono text-sm">{value}</span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'ai', label: 'Total Tokens' },
  },
  {
    id: 'promptTokens',
    accessorFn: (row) => getSpanAttribute(row, 'gen_ai.usage.input_tokens'),
    header: 'Prompt',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="font-mono text-sm">{value}</span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'ai', label: 'Prompt Tokens' },
  },
  {
    id: 'completionTokens',
    accessorFn: (row) => getSpanAttribute(row, 'gen_ai.usage.output_tokens'),
    header: 'Completion',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      return value ? (
        <span className="font-mono text-sm">{value}</span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'ai', label: 'Completion Tokens' },
  },
];

export const defaultColumnVisibility: VisibilityState = {
  receivedAt: true,
  traceId: true,
  spanName: true,
  aiProvider: true,
  aiModel: true,
  httpStatusCode: true,
  duration: true,
  statusCode: true,
  serviceName: false,
  totalTokens: false,
  promptTokens: false,
  completionTokens: false,
};
