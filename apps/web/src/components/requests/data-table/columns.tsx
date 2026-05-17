'use client';

import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import { parseSpanAttributes, type TraceSpanRow } from '@trace-flow/spans';
import { GEN_AI, GEN_AI_COST, GEN_AI_USAGE, HTTP } from '@trace-flow/otel-conventions';
import { cn } from '@/lib/utils';
import { formatCurrency, formatNumber, formatRelativeTime } from '@/lib/format';
import { calculateCacheHitRate } from '@/lib/cacheMetrics';
import { AlertIndicator } from '@/components/alerts';
import { ModelPill } from '@/components/traces/spans-table/ModelPill';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TraceAlertSummary } from '@/types/alerts';

export type RequestRow = Pick<
  TraceSpanRow,
  | 'Timestamp'
  | 'TraceId'
  | 'SpanId'
  | 'SpanName'
  | 'ServiceName'
  | 'Duration'
  | 'StatusCode'
  | 'SpanAttributes'
> & {
  ReceivedAt: number;
  BaggageOperation: string;
};

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
  return parseSpanAttributes(row.SpanAttributes)[key];
}

function formatTimestamp(nanoseconds: number) {
  const milliseconds = nanoseconds / 1_000_000;
  return new Date(milliseconds).toLocaleString();
}

function formatDurationNs(nanoseconds: number) {
  const milliseconds = nanoseconds / 1_000_000;
  if (milliseconds < 1) return `${(milliseconds * 1000).toFixed(0)}μs`;
  if (milliseconds < 1000) return `${milliseconds.toFixed(1)}ms`;
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function truncateId(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
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
    id: 'aiProvider',
    accessorFn: (row) => getSpanAttribute(row, GEN_AI.SYSTEM),
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
    accessorFn: (row) => {
      const attrs = parseSpanAttributes(row.SpanAttributes);
      return { model: attrs[GEN_AI.REQUEST_MODEL], provider: attrs[GEN_AI.SYSTEM] };
    },
    header: 'Model',
    cell: ({ getValue }) => {
      const { model, provider } = getValue<{ model?: string; provider?: string }>();
      return model ? (
        <ModelPill model={model} provider={provider} />
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'ai', label: 'Model' },
  },
  {
    id: 'operation',
    accessorKey: 'BaggageOperation',
    header: 'Operation',
    cell: ({ getValue }) => {
      const value = getValue<string>();
      return value ? (
        <span className="text-sm font-medium text-foreground">{value}</span>
      ) : (
        <span className="text-sm italic text-muted-foreground/50">unnamed</span>
      );
    },
    meta: { category: 'standard', label: 'Operation' },
  },
  {
    id: 'duration',
    accessorKey: 'Duration',
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
    meta: { category: 'standard', label: 'Duration' },
  },
  {
    id: 'promptTokens',
    accessorFn: (row) => getSpanAttribute(row, GEN_AI_USAGE.INPUT_TOKENS),
    header: 'Prompt',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      if (!value) return <span className="text-muted-foreground/50">-</span>;
      const num = parseInt(value, 10);
      return (
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {formatNumber(num)}
        </span>
      );
    },
    meta: { category: 'ai', label: 'Prompt Tokens' },
  },
  {
    id: 'completionTokens',
    accessorFn: (row) => getSpanAttribute(row, GEN_AI_USAGE.OUTPUT_TOKENS),
    header: 'Completion',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      if (!value) return <span className="text-muted-foreground/50">-</span>;
      const num = parseInt(value, 10);
      return (
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {formatNumber(num)}
        </span>
      );
    },
    meta: { category: 'ai', label: 'Completion Tokens' },
  },
  {
    id: 'cost',
    accessorFn: (row) => getSpanAttribute(row, GEN_AI_COST.TOTAL),
    header: 'Cost',
    cell: ({ getValue }) => {
      const value = getValue<string | undefined>();
      if (!value) return <span className="text-muted-foreground/50">-</span>;
      const cost = parseFloat(value);
      return <span className="font-mono text-sm text-emerald-400">{formatCurrency(cost)}</span>;
    },
    meta: { category: 'ai', label: 'Cost' },
  },
  {
    id: 'cacheHitRate',
    accessorFn: (row) => {
      const attrs = parseSpanAttributes(row.SpanAttributes);
      const cacheRead = parseInt(attrs[GEN_AI_USAGE.CACHE_READ_INPUT_TOKENS] ?? '0', 10) || 0;
      const cacheCreation =
        parseInt(attrs[GEN_AI_USAGE.CACHE_CREATION_INPUT_TOKENS] ?? '0', 10) || 0;
      const promptTotal = parseInt(attrs[GEN_AI_USAGE.INPUT_TOKENS] ?? '0', 10) || 0;
      return calculateCacheHitRate(cacheRead, cacheCreation, promptTotal);
    },
    header: 'Cache',
    cell: ({ getValue }) => {
      const value = getValue<number | null>();
      if (value === null) return <span className="text-muted-foreground/50">-</span>;
      const percent = Math.round(value);
      return (
        <span
          className={cn(
            'font-mono text-sm',
            percent >= 80
              ? 'text-emerald-400'
              : percent >= 50
                ? 'text-amber-400'
                : 'text-muted-foreground',
          )}
        >
          {percent}%
        </span>
      );
    },
    meta: { category: 'ai', label: 'Cache Hit Rate' },
  },
  {
    id: 'httpStatusCode',
    accessorFn: (row) => getSpanAttribute(row, HTTP.RESPONSE_STATUS_CODE),
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
    id: 'receivedAt',
    accessorKey: 'ReceivedAt',
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
  // Hidden by default — available in column toggle
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
    id: 'spanName',
    accessorKey: 'SpanName',
    header: 'Request Name',
    cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
    meta: { category: 'standard', label: 'Request Name' },
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
      const attrs = parseSpanAttributes(row.SpanAttributes);
      const input = parseInt(attrs[GEN_AI_USAGE.INPUT_TOKENS] ?? '0', 10) || 0;
      const output = parseInt(attrs[GEN_AI_USAGE.OUTPUT_TOKENS] ?? '0', 10) || 0;
      return input + output > 0 ? input + output : undefined;
    },
    header: 'Tokens',
    cell: ({ getValue }) => {
      const value = getValue<number | undefined>();
      return value ? (
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {formatNumber(value)}
        </span>
      ) : (
        <span className="text-muted-foreground/50">-</span>
      );
    },
    meta: { category: 'ai', label: 'Total Tokens' },
  },
];

export const defaultColumnVisibility: VisibilityState = {
  aiModel: true,
  aiProvider: true,
  operation: true,
  httpStatusCode: true,
  duration: true,
  promptTokens: true,
  completionTokens: true,
  cost: true,
  cacheHitRate: true,
  receivedAt: true,
  traceId: false,
  statusCode: false,
  spanName: false,
  serviceName: false,
  totalTokens: false,
};
