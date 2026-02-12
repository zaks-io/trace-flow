import type { ChartConfig } from '@/components/ui/chart';

export type TimeRange = '7d' | '30d' | '90d';

export const TIME_RANGES: { value: TimeRange; label: string; ms: number }[] = [
  { value: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '90d', ms: 90 * 24 * 60 * 60 * 1000 },
];

export type TimeseriesMetric = 'cost' | 'tokens' | 'requests' | 'latency';

export const costChartConfig = {
  input_cost_usd: { label: 'Input', color: '#8b5cf6' },
  output_cost_usd: { label: 'Output', color: '#3b82f6' },
  cache_read_cost_usd: { label: 'Cache Read', color: '#10b981' },
  cache_creation_cost_usd: { label: 'Cache Write', color: '#f59e0b' },
  reasoning_cost_usd: { label: 'Reasoning', color: '#ef4444' },
} satisfies ChartConfig;

export const latencyChartConfig = {
  avg_duration_ms: { label: 'Avg', color: '#f59e0b' },
  p95_duration_ms: { label: 'P95', color: '#ef4444' },
} satisfies ChartConfig;

export const tokensChartConfig = {
  total_tokens: { label: 'Tokens', color: '#10b981' },
} satisfies ChartConfig;

export const requestsChartConfig = {
  request_count: { label: 'Requests', color: '#8b5cf6' },
} satisfies ChartConfig;

export const PIE_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444'] as const;

export const pieChartConfig = {
  value: { label: 'Cost' },
  input: { label: 'Input', color: '#8b5cf6' },
  output: { label: 'Output', color: '#3b82f6' },
  cache_read: { label: 'Cache Read', color: '#10b981' },
  cache_write: { label: 'Cache Write', color: '#f59e0b' },
  reasoning: { label: 'Reasoning', color: '#ef4444' },
} satisfies ChartConfig;

export const providerChartConfig = {
  total_cost_usd: { label: 'Cost', color: '#8b5cf6' },
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

export interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
  accent?: 'purple' | 'blue' | 'emerald' | 'amber';
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
