import { formatNumber, formatPercent } from '@/lib/format';
import type { SummaryRow } from './types';

type CostCoverage = Pick<
  SummaryRow,
  | 'request_count'
  | 'cost_priced_count'
  | 'cost_partial_count'
  | 'cost_unpriced_count'
  | 'cost_priced_tokens'
  | 'cost_coverage_ratio'
>;

export function isCostUnknown(summary: CostCoverage): boolean {
  return summary.cost_unpriced_count > 0 && summary.cost_unpriced_count === summary.request_count;
}

export function costCoverageLabels(summary: CostCoverage) {
  const imported =
    summary.cost_priced_count + summary.cost_partial_count + summary.cost_unpriced_count;
  if (imported === 0) return [];
  return [
    {
      label: 'Priced',
      value: formatNumber(summary.cost_priced_count),
      color: 'var(--color-chart-3)',
    },
    ...(summary.cost_partial_count > 0
      ? [
          {
            label: 'Partial',
            value: formatNumber(summary.cost_partial_count),
            color: 'var(--color-chart-4)',
          },
        ]
      : []),
    ...(summary.cost_unpriced_count > 0
      ? [
          {
            label: 'Unpriced',
            value: formatNumber(summary.cost_unpriced_count),
            color: 'var(--color-chart-6)',
          },
        ]
      : []),
    {
      label: 'Priced Tokens',
      value: formatNumber(summary.cost_priced_tokens),
      color: 'var(--color-muted-foreground)',
    },
    ...(summary.cost_coverage_ratio !== null
      ? [
          {
            label: 'Token Coverage',
            value: formatPercent(summary.cost_coverage_ratio * 100),
            color: 'var(--color-muted-foreground)',
          },
        ]
      : []),
  ];
}
