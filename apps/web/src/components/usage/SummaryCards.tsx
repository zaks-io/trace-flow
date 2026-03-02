'use client';

import { BarCard, formatCostCompact } from '@/components/BarCard';
import { formatNumber, formatCurrency, formatDuration, formatPercent } from '@/lib/format';
import { ProjectedCostCard } from './ProjectedCostCard';
import type { SummaryRow, RequestStatsRow, CostForecastRow } from './types';

interface SummaryCardsProps {
  summary: SummaryRow | undefined;
  prevSummary: SummaryRow | undefined;
  requestStats: RequestStatsRow | undefined;
  forecast: CostForecastRow | null;
}

function computeDelta(current: number | undefined, previous: number | undefined) {
  if (current === undefined || previous === undefined || previous === 0) return undefined;
  return ((current - previous) / previous) * 100;
}

export function SummaryCards({ summary, prevSummary, requestStats, forecast }: SummaryCardsProps) {
  const requestDelta = computeDelta(summary?.request_count, prevSummary?.request_count);
  const costDelta = computeDelta(summary?.total_cost_usd, prevSummary?.total_cost_usd);

  const errorCount = summary?.error_count ?? 0;
  const successCount = summary ? summary.request_count - errorCount : 0;
  const errorRate =
    summary && summary.request_count > 0 ? (errorCount / summary.request_count) * 100 : 0;

  const costPerRequest =
    summary && summary.request_count > 0 ? summary.total_cost_usd / summary.request_count : null;

  const cacheHitRate =
    summary && summary.input_tokens > 0
      ? (summary.cache_read_input_tokens / summary.input_tokens) * 100
      : 0;

  // Estimated savings: what cached tokens would have cost at full input rate minus what they actually cost
  const effectiveInputRate =
    summary && summary.new_input_tokens > 0 ? summary.input_cost_usd / summary.new_input_tokens : 0;
  const fullPriceForCached = summary ? summary.cache_read_input_tokens * effectiveInputRate : 0;
  const cacheSavings = fullPriceForCached - (summary?.cache_read_cost_usd ?? 0);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {/* Requests */}
      <BarCard
        label="Requests"
        value={summary ? formatNumber(summary.request_count) : '-'}
        accent="from-chart-5/20 to-chart-5/5"
        segments={
          summary
            ? [
                {
                  key: 'success',
                  label: 'Success',
                  value: successCount,
                  color: 'var(--color-chart-3)',
                },
                { key: 'error', label: 'Error', value: errorCount, color: 'var(--color-chart-6)' },
              ]
            : []
        }
        total={summary?.request_count ?? 0}
        formatter={formatNumber}
        inlineLabels={
          summary
            ? [
                {
                  label: 'Success',
                  value: formatNumber(successCount),
                  color: 'var(--color-chart-3)',
                },
                { label: 'Error', value: formatNumber(errorCount), color: 'var(--color-chart-6)' },
                {
                  label: 'Error Rate',
                  value: formatPercent(errorRate),
                  color: 'var(--color-chart-6)',
                },
              ]
            : undefined
        }
        delta={
          requestDelta !== undefined
            ? { percent: requestDelta, label: 'vs prior period' }
            : undefined
        }
      />

      {/* Total Cost */}
      <BarCard
        label="Total Cost"
        value={summary ? formatCurrency(summary.total_cost_usd) : '-'}
        accent="from-chart-4/20 to-chart-4/5"
        segments={
          summary
            ? [
                {
                  key: 'input',
                  label: 'Input',
                  value: summary.input_cost_usd,
                  color: 'var(--color-chart-1)',
                },
                {
                  key: 'output',
                  label: 'Output',
                  value: summary.output_cost_usd,
                  color: 'var(--color-chart-2)',
                },
                {
                  key: 'cache_read',
                  label: 'Cache Read',
                  value: summary.cache_read_cost_usd,
                  color: 'var(--color-chart-3)',
                },
                {
                  key: 'cache_write',
                  label: 'Cache Write',
                  value: summary.cache_creation_cost_usd,
                  color: 'var(--color-chart-4)',
                },
                {
                  key: 'reasoning',
                  label: 'Reasoning',
                  value: summary.reasoning_cost_usd,
                  color: 'var(--color-chart-5)',
                },
              ]
            : []
        }
        total={summary?.total_cost_usd ?? 0}
        formatter={formatCostCompact}
        delta={
          costDelta !== undefined ? { percent: costDelta, label: 'vs prior period' } : undefined
        }
        invertDelta
      />

      {/* Projected Cost */}
      <ProjectedCostCard forecast={forecast} />

      {/* Cost / Request */}
      <BarCard
        label="Cost / Request"
        value={costPerRequest !== null ? formatCurrency(costPerRequest) : '-'}
        accent="from-chart-2/20 to-chart-2/5"
        segments={[]}
        total={0}
        formatter={formatCostCompact}
        inlineLabels={
          requestStats
            ? [
                {
                  label: 'Min',
                  value: formatCurrency(requestStats.min_cost_usd),
                  color: 'var(--color-chart-3)',
                },
                {
                  label: 'P95',
                  value: formatCurrency(requestStats.p95_cost_usd),
                  color: 'var(--color-chart-2)',
                },
                {
                  label: 'P99',
                  value: formatCurrency(requestStats.p99_cost_usd),
                  color: 'var(--color-chart-6)',
                },
                {
                  label: 'Max',
                  value: formatCurrency(requestStats.max_cost_usd),
                  color: 'var(--color-chart-1)',
                },
                {
                  label: 'σ',
                  value: formatCurrency(requestStats.stddev_cost_usd),
                  color: 'var(--color-muted-foreground)',
                },
              ]
            : undefined
        }
      />

      {/* Duration */}
      <BarCard
        label="Duration"
        value={summary ? formatDuration(summary.avg_duration_ms) : '-'}
        accent="from-chart-7/20 to-chart-7/5"
        segments={[]}
        total={0}
        formatter={(n) => formatDuration(n)}
        inlineLabels={
          requestStats
            ? [
                {
                  label: 'Min',
                  value: formatDuration(requestStats.min_duration_ms),
                  color: 'var(--color-chart-3)',
                },
                {
                  label: 'P95',
                  value: formatDuration(requestStats.p95_duration_ms),
                  color: 'var(--color-chart-2)',
                },
                {
                  label: 'P99',
                  value: formatDuration(requestStats.p99_duration_ms),
                  color: 'var(--color-chart-6)',
                },
                {
                  label: 'Max',
                  value: formatDuration(requestStats.max_duration_ms),
                  color: 'var(--color-chart-1)',
                },
                {
                  label: 'σ',
                  value: formatDuration(requestStats.stddev_duration_ms),
                  color: 'var(--color-muted-foreground)',
                },
              ]
            : undefined
        }
      />

      {/* Caching */}
      <BarCard
        label="Caching"
        value={summary ? formatPercent(cacheHitRate) + ' hit rate' : '-'}
        accent="from-chart-3/20 to-chart-3/5"
        segments={
          summary && summary.input_tokens > 0
            ? [
                {
                  key: 'cached',
                  label: 'Cached',
                  value: summary.cache_read_input_tokens,
                  color: 'var(--color-chart-3)',
                },
                {
                  key: 'uncached',
                  label: 'Uncached',
                  value: summary.new_input_tokens,
                  color: 'var(--color-chart-8, var(--color-muted-foreground))',
                },
              ]
            : []
        }
        total={summary?.input_tokens ?? 0}
        formatter={formatNumber}
        showPercent
        inlineLabels={
          summary
            ? [
                ...(cacheSavings > 0
                  ? [
                      {
                        label: 'Est. Savings',
                        value: formatCurrency(cacheSavings),
                        color: 'var(--color-chart-3)',
                      },
                    ]
                  : summary.cache_read_input_tokens > 0 && summary.new_input_tokens === 0
                    ? [
                        {
                          label: 'Est. Savings',
                          value: 'N/A',
                          color: 'var(--color-muted-foreground)',
                        },
                      ]
                    : []),
                {
                  label: 'Read Cost',
                  value: formatCurrency(summary.cache_read_cost_usd),
                  color: 'var(--color-chart-4)',
                },
                {
                  label: 'Write Cost',
                  value: formatCurrency(summary.cache_creation_cost_usd),
                  color: 'var(--color-chart-5)',
                },
              ]
            : undefined
        }
      />
    </div>
  );
}
