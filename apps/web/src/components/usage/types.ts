import type { ChartConfig } from '@/components/ui/chart';

export type TimeRange = '7d' | '30d' | '90d';

export const TIME_RANGES: { value: TimeRange; label: string; ms: number }[] = [
  { value: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '90d', ms: 90 * 24 * 60 * 60 * 1000 },
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
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
  new_input_tokens: number;
}

export interface TimeseriesRow extends CostBreakdownRow, LatencyRow {
  bucket_start: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  total_tokens: number;
  new_input_tokens: number;
}

export interface ModelRow extends CostBreakdownRow, LatencyRow {
  model: string;
  request_count: number;
  input_tokens: number;
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
  total_cost_usd: number;
  total_tokens: number;
}

export interface OperationRow extends CostBreakdownRow, LatencyRow {
  operation: string;
  request_count: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface ApiKeyRow extends CostBreakdownRow, LatencyRow {
  api_key: string;
  request_count: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface TinybirdResponse<T> {
  data: T[];
}

export interface RequestStatsRow {
  min_duration_ms: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  stddev_duration_ms: number;
  p95_duration_ms: number;
  p99_duration_ms: number;
  min_cost_usd: number;
  avg_cost_usd: number;
  max_cost_usd: number;
  stddev_cost_usd: number;
  p95_cost_usd: number;
  p99_cost_usd: number;
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
  basis_days: number;
  days_elapsed_in_month: number;
  days_remaining_in_month: number;
  trend: string;
  trend_percent: number;
  anomaly_count: number;
  anomalies: [string, number, number, number][];
  insufficient_data: number;
}
