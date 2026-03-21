import { calculateCacheHitRate } from './cacheMetrics';

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
