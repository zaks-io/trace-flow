export type TimeRangeValue = '24h' | '7d' | '30d' | '90d';
export type ChartMetric = 'requestCount' | 'p95LatencyMs' | 'serverErrorRate' | 'totalTokens';
export type BreakdownDimension =
  | 'provider'
  | 'statusCode'
  | 'operation'
  | 'model'
  | 'skipReason'
  | 'orgId';

interface SummaryData {
  requestCount: number;
  serverErrorCount: number;
  serverErrorRate: number;
  skipCount: number;
  skipRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgTtfbMs: number;
  p95TtfbMs: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  responseBytes: number;
}

export interface TimeseriesRow {
  bucket: string;
  requestCount: number;
  serverErrorRate: number;
  skipRate: number;
  p95LatencyMs: number;
  p95TtfbMs: number;
  totalTokens: number;
  responseBytes: number;
}

export interface BreakdownRow {
  dimension: string;
  requestCount: number;
  serverErrorRate: number;
  skipRate: number;
  p95LatencyMs: number;
  totalTokens: number;
  responseBytes: number;
}

export interface DashboardData {
  dataset: string;
  granularity: string;
  summary: SummaryData;
  timeseries: TimeseriesRow[];
  breakdowns: Record<BreakdownDimension, BreakdownRow[]>;
  filterOptions: {
    providers: string[];
    statusCodes: string[];
    operations: string[];
    skipReasons: string[];
    models: string[];
    orgIds: string[];
  };
}

export interface ExplorerRow {
  timestamp: string;
  sampleInterval: number;
  orgId: string;
  provider: string;
  statusCode: string;
  operation: string;
  skipReason: string;
  isSse: string;
  model: string;
  totalLatencyMs: number;
  prepLatencyMs: number;
  ttfbMs: number;
  isServerError: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  responseBytes: number;
}

export interface ExplorerResponse {
  sql: string;
  columns: { name: string; type: string }[];
  rows: ExplorerRow[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface QueryRunnerResult {
  sql: string;
  columns: { name: string; type: string }[];
  rows: string[][];
  rowCount: number;
}

export interface FiltersState {
  orgId: string;
  provider: string;
  statusCode: string;
  operation: string;
  skipReason: string;
  isSse: '' | '0' | '1';
  model: string;
}
