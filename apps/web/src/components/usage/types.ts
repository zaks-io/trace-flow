import type { ChartConfig } from '@/components/ui/chart';

export type TimeRange = 'this-month' | 'last-month' | '7d' | '30d' | '90d';

const DAY_MS = 24 * 60 * 60 * 1000;

interface TimeRangeConfig {
  value: TimeRange;
  label: string;
  ms?: number;
  getRange?: () => { start: number; end: number; prevStart: number; prevEnd: number };
}

function getMonthRange(monthsAgo: number): {
  start: number;
  end: number;
  prevStart: number;
  prevEnd: number;
} {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = Date.UTC(y, m - monthsAgo, 1);
  const prevStart = Date.UTC(y, m - monthsAgo - 1, 1);
  const prevEnd = start; // first ms of current period = end of previous
  if (monthsAgo === 0) {
    return { start, end: now.getTime(), prevStart, prevEnd };
  }
  const end = Date.UTC(y, m - monthsAgo + 1, 0, 23, 59, 59, 999);
  return { start, end, prevStart, prevEnd };
}

export const TIME_RANGES: TimeRangeConfig[] = [
  { value: 'this-month', label: 'This Month', getRange: () => getMonthRange(0) },
  { value: 'last-month', label: 'Last Month', getRange: () => getMonthRange(1) },
  { value: '7d', label: '7d', ms: 7 * DAY_MS },
  { value: '30d', label: '30d', ms: 30 * DAY_MS },
  { value: '90d', label: '90d', ms: 90 * DAY_MS },
];

export type TimeseriesMetric = 'cost' | 'tokens' | 'requests' | 'duration';

export const costChartConfig = {
  input_cost_usd: { label: 'Input', color: 'var(--color-chart-1)' },
  output_cost_usd: { label: 'Output', color: 'var(--color-chart-2)' },
  cache_read_cost_usd: { label: 'Cache Read', color: 'var(--color-chart-3)' },
  cache_creation_cost_usd: { label: 'Cache Write', color: 'var(--color-chart-4)' },
  reasoning_cost_usd: { label: 'Reasoning', color: 'var(--color-chart-5)' },
} satisfies ChartConfig;

export const durationChartConfig = {
  avg_duration_ms: { label: 'Avg', color: 'var(--color-chart-3)' },
  p95_duration_ms: { label: 'P95', color: 'var(--color-chart-6)' },
} satisfies ChartConfig;

export const tokensChartConfig = {
  total_tokens: { label: 'Tokens', color: 'var(--color-chart-4)' },
} satisfies ChartConfig;

export const requestsChartConfig = {
  request_count: { label: 'Requests', color: 'var(--color-chart-1)' },
} satisfies ChartConfig;

export const PIE_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
] as const;

export const pieChartConfig = {
  value: { label: 'Cost' },
  input: { label: 'Input', color: 'var(--color-chart-1)' },
  output: { label: 'Output', color: 'var(--color-chart-2)' },
  cache_read: { label: 'Cache Read', color: 'var(--color-chart-3)' },
  cache_write: { label: 'Cache Write', color: 'var(--color-chart-4)' },
  reasoning: { label: 'Reasoning', color: 'var(--color-chart-5)' },
} satisfies ChartConfig;

export const providerChartConfig = {
  total_cost_usd: { label: 'Cost', color: 'var(--color-chart-1)' },
} satisfies ChartConfig;

interface CostBreakdownRow {
  input_cost_usd: number;
  output_cost_usd: number;
  cache_read_cost_usd: number;
  cache_creation_cost_usd: number;
  reasoning_cost_usd: number;
  prompt_baseline_cost_usd: number;
  cache_impact_cost_usd: number;
  upstream_cost_usd: number;
}

interface LatencyRow {
  avg_duration_ms: number;
  max_duration_ms: number;
  p95_duration_ms: number;
}

export interface SummaryRow extends CostBreakdownRow, LatencyRow {
  request_count: number;
  error_count: number;
  input_tokens: number;

  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface TimeseriesRow extends CostBreakdownRow, LatencyRow {
  bucket_start: string;
  request_count: number;
  input_tokens: number;

  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface ModelRow extends CostBreakdownRow, LatencyRow {
  model: string;
  request_count: number;
  input_tokens: number;

  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  cost_per_1k_output_tokens: number | null;
  total_tokens: number;
}

export interface ProviderRow extends CostBreakdownRow, LatencyRow {
  provider: string;
  request_count: number;
  input_tokens: number;

  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface OperationRow extends CostBreakdownRow, LatencyRow {
  operation: string;
  request_count: number;
  input_tokens: number;

  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface OperationLeaderboardRow extends OperationRow {
  unique_user_count: number;
  cost_per_request_usd: number | null;
  cost_per_user_usd: number | null;
  cache_hit_rate: number | null;
}

export interface OperationUserRow extends CostBreakdownRow, LatencyRow {
  baggage_user_id: string;
  request_count: number;
  input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
  cost_per_request_usd: number | null;
  cache_hit_rate: number | null;
}

export interface ApiKeyRow extends CostBreakdownRow, LatencyRow {
  api_key: string;
  request_count: number;
  input_tokens: number;

  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface TinybirdResponse<T> {
  data: T[];
}

/**
 * Per-request cost/duration distribution + cost concentration for one slice (one API key OR
 * operation OR model). Robust estimators only (median/IQR/quantileExact) per ADR 0021 — no
 * mean/stddev, which mislead on heavy-tailed cost. The concentration fields (gini, lorenz,
 * half_spend, decile buckets) answer "uniform vs fat-tailed" for this slice's requests.
 */
export interface RequestStatsRow {
  request_count: number;
  total_cost_usd: number;

  cost_min: number;
  cost_p25: number;
  cost_p50: number;
  cost_p75: number;
  cost_p95: number;
  cost_p99: number;
  cost_max: number;

  duration_min: number;
  duration_p25: number;
  duration_p50: number;
  duration_p75: number;
  duration_p95: number;
  duration_p99: number;
  duration_max: number;

  gini: number;
  half_spend_request_count: number;
  lorenz_request_pct: number[];
  lorenz_cost_pct: number[];

  cost_bucket_lo: number[];
  cost_bucket_hi: number[];
  cost_bucket_count: number[];
  cost_bucket_sum: number[];
}

export type ModelSortKey =
  | 'request_count'
  | 'total_cost_usd'
  | 'cost_per_1k_output_tokens'
  | 'avg_duration_ms'
  | 'p95_duration_ms';

export interface CostForecastRow {
  projected_monthly_cost: number;
  month_to_date_cost: number;
  confidence_low: number;
  confidence_high: number;
  daily_average: number;
  days_elapsed_in_month: number;
  days_remaining_in_month: number;
  trend: string;
  trend_percent: number;
  anomaly_count: number;
  anomalies: [string, number, number, number][] | null;
  insufficient_data: number;
}

export interface CostTailRiskRow {
  api_key: string;
  provider: string;
  model: string;
  operation_name: string;
  baggage_operation: string;
  baggage_user_id: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  uncached_input_tokens: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  cost_p50_usd: number;
  cost_p95_usd: number;
  cost_p99_usd: number;
  cost_max_usd: number;
  max_cost_trace_id: string | null;
  max_cost_span_id: string | null;
  p99_p50_ratio: number | null;
}

export type TokenRatioDriftState = 'ok' | 'insufficient_data';

export interface TokenRatioDriftRow {
  api_key: string;
  provider: string;
  model: string;
  operation_name: string;
  baggage_operation: string;
  baggage_user_id: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  baseline_request_count: number;
  baseline_input_tokens: number;
  baseline_output_tokens: number;
  current_output_input_ratio: number | null;
  baseline_output_input_ratio: number | null;
  output_input_ratio_delta: number | null;
  output_input_ratio_percent_delta: number | null;
  current_input_tokens_per_request: number | null;
  baseline_input_tokens_per_request: number | null;
  input_tokens_per_request_delta: number | null;
  input_tokens_per_request_percent_delta: number | null;
  state: TokenRatioDriftState | string;
}
