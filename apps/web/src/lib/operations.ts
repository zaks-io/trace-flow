import { calculateCacheHitRate } from './cacheMetrics';

export type LeaderboardSortKey =
  | 'request_count'
  | 'total_cost_usd'
  | 'cost_per_request'
  | 'cost_per_user'
  | 'unique_user_count'
  | 'cache_hit_rate'
  | 'avg_duration_ms'
  | 'p95_duration_ms';

interface AggregateOperationMetrics {
  cache_hit_rate?: number | null;
  cost_per_request_usd?: number | null;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  input_tokens: number;
  request_count: number;
  total_cost_usd: number;
}

export function getAggregateCacheHitRate(metrics: AggregateOperationMetrics): number | null {
  if (metrics.cache_hit_rate != null) {
    return metrics.cache_hit_rate;
  }

  return calculateCacheHitRate(
    metrics.cache_read_input_tokens,
    metrics.cache_creation_input_tokens,
    metrics.input_tokens,
  );
}

export function getCostPerRequest(metrics: AggregateOperationMetrics): number | null {
  if (metrics.cost_per_request_usd != null) {
    return metrics.cost_per_request_usd;
  }

  if (metrics.request_count === 0) {
    return null;
  }

  return metrics.total_cost_usd / metrics.request_count;
}

interface LeaderboardSortRow extends AggregateOperationMetrics {
  cost_per_user_usd?: number | null;
  unique_user_count?: number;
  avg_duration_ms?: number;
  p95_duration_ms?: number;
}

export function getLeaderboardSortValue(
  row: LeaderboardSortRow,
  sortKey: LeaderboardSortKey,
): number {
  switch (sortKey) {
    case 'cost_per_request':
      return getCostPerRequest(row) ?? 0;
    case 'cost_per_user':
      return row.cost_per_user_usd ?? 0;
    case 'cache_hit_rate':
      return getAggregateCacheHitRate(row) ?? 0;
    default:
      return row[sortKey] ?? 0;
  }
}
