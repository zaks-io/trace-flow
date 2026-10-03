'use client';

import { BarCard, formatCostCompact } from '@/components/shared/BarCard';
import { TOKEN_TYPE_SERIES, buildTokenSegments } from '@/components/shared/tokenTypes';
import { type OperationLeaderboardRow } from '@/components/usage/types';
import { formatCurrency, formatDuration, formatNumber } from '@/lib/format';
import { getAggregateCacheHitRate, getCostPerRequest } from '@/lib/operations';
import { formatCacheHitRate } from '@/lib/cacheMetrics';

export function SummaryCards({ operation }: { operation: OperationLeaderboardRow }) {
  const cacheHitRate = getAggregateCacheHitRate(operation);
  const costPerRequest = getCostPerRequest(operation);

  return (
    <div className="stagger-children grid grid-cols-2 gap-3 lg:grid-cols-4">
      <BarCard
        label="Cost"
        value={formatCurrency(operation.total_cost_usd)}
        accent="from-chart-4/20 to-chart-4/5"
        compact
        segments={buildTokenSegments({
          input: operation.input_cost_usd,
          cacheRead: operation.cache_read_cost_usd,
          cacheWrite: operation.cache_creation_cost_usd,
          output: operation.output_cost_usd,
          reasoning: operation.reasoning_cost_usd,
        })}
        total={operation.total_cost_usd}
        formatter={formatCostCompact}
        inlineLabels={[
          {
            label: '/ request',
            value: formatCurrency(costPerRequest),
            color: 'var(--color-muted-foreground)',
          },
        ]}
      />
      <BarCard
        label="Requests"
        value={formatNumber(operation.request_count)}
        accent="from-chart-5/20 to-chart-5/5"
        compact
        segments={[]}
        total={0}
        formatter={formatNumber}
        inlineLabels={[
          {
            label: 'tokens',
            value: formatNumber(operation.total_tokens),
            color: 'var(--color-muted-foreground)',
          },
        ]}
      />
      <BarCard
        label="Cache Hit Rate"
        value={formatCacheHitRate(cacheHitRate)}
        accent="from-chart-3/20 to-chart-3/5"
        compact
        segments={
          operation.input_tokens > 0
            ? [
                {
                  key: 'uncached',
                  label: 'Uncached',
                  value: operation.uncached_input_tokens,
                  color: TOKEN_TYPE_SERIES.input.color,
                },
                {
                  key: 'cached',
                  label: 'Cached',
                  value: operation.cache_read_input_tokens,
                  color: TOKEN_TYPE_SERIES.cacheRead.color,
                },
                {
                  key: 'warmup',
                  label: 'Warmup',
                  value: operation.cache_creation_input_tokens,
                  color: TOKEN_TYPE_SERIES.cacheWrite.color,
                },
              ]
            : []
        }
        total={operation.input_tokens}
        formatter={formatNumber}
        showPercent
      />
      <BarCard
        label="Latency"
        value={formatDuration(operation.avg_duration_ms)}
        accent="from-chart-7/20 to-chart-7/5"
        compact
        segments={[]}
        total={0}
        formatter={formatDuration}
        inlineLabels={[
          {
            label: 'P95',
            value: formatDuration(operation.p95_duration_ms),
            color: 'var(--color-chart-7)',
          },
          {
            label: 'Max',
            value: formatDuration(operation.max_duration_ms),
            color: 'var(--color-chart-5)',
          },
        ]}
      />
    </div>
  );
}
