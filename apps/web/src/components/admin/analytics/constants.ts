import type { ChartMetric, TimeRangeValue } from './types';

export const TIME_RANGES: { value: TimeRangeValue; label: string; ms: number }[] = [
  { value: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '90d', ms: 90 * 24 * 60 * 60 * 1000 },
];

export const EMPTY_VALUE = '__empty__';

// Consistent color-to-metric mapping using chart CSS variables
export const ACCENT = {
  requests: 'var(--chart-1)',
  errors: 'var(--chart-6)',
  latency: 'var(--chart-4)',
  tokens: 'var(--chart-3)',
  skipRate: 'var(--chart-2)',
  ttfb: 'var(--chart-7)',
  promptComp: 'var(--chart-5)',
  bytes: 'var(--chart-8)',
} as const;

export const explorerDefaultVisibility = {
  timestamp: true,
  sampleInterval: true,
  orgId: true,
  provider: true,
  statusCode: true,
  operation: true,
  skipReason: true,
  isSse: true,
  model: true,
  totalLatencyMs: true,
  prepLatencyMs: false,
  ttfbMs: true,
  isServerError: true,
  totalTokens: true,
  promptTokens: false,
  completionTokens: false,
  cacheReadTokens: false,
  responseBytes: true,
};

export const chartConfig = {
  requestCount: { label: 'Requests', color: 'var(--chart-1)' },
  p95LatencyMs: { label: 'P95 Latency', color: 'var(--chart-4)' },
  serverErrorRate: { label: 'Error Rate', color: 'var(--chart-6)' },
  totalTokens: { label: 'Tokens', color: 'var(--chart-3)' },
};

export const CHART_METRIC_COLORS: Record<ChartMetric, string> = {
  requestCount: ACCENT.requests,
  p95LatencyMs: ACCENT.latency,
  serverErrorRate: ACCENT.errors,
  totalTokens: ACCENT.tokens,
};

export const explorerColumns = [
  'timestamp',
  'sampleInterval',
  'orgId',
  'provider',
  'statusCode',
  'operation',
  'skipReason',
  'isSse',
  'model',
  'totalLatencyMs',
  'prepLatencyMs',
  'ttfbMs',
  'isServerError',
  'totalTokens',
  'promptTokens',
  'completionTokens',
  'cacheReadTokens',
  'responseBytes',
] as const;

export const NUMERIC_EXPLORER_COLUMNS = new Set([
  'sampleInterval',
  'totalLatencyMs',
  'prepLatencyMs',
  'ttfbMs',
  'isServerError',
  'totalTokens',
  'promptTokens',
  'completionTokens',
  'cacheReadTokens',
  'responseBytes',
]);

export const STATUS_FIELDS = new Set(['statusCode', 'isServerError', 'isSse']);

export const BOOLEAN_COLUMNS = new Set(['isServerError', 'isSse']);

export type ExplorerColumn = (typeof explorerColumns)[number];
