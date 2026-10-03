import { formatNumber, formatPercent } from '@/lib/format';
import type { SummaryRow } from './types';

type CostCoverage = Pick<
  SummaryRow,
  | 'total_cost_usd'
  | 'cost_proxy_count'
  | 'cost_unassessed_count'
  | 'cost_priced_count'
  | 'cost_partial_count'
  | 'cost_unpriced_count'
  | 'cost_priced_tokens'
  | 'cost_coverage_ratio'
>;

export function isCostUnknown(summary: CostCoverage): boolean {
  const known = summary.cost_priced_count + summary.cost_partial_count + summary.cost_proxy_count;
  const unknown = summary.cost_unpriced_count + summary.cost_unassessed_count;
  return unknown > 0 && known === 0 && summary.total_cost_usd === 0;
}

export function isCostIncomplete(summary: CostCoverage): boolean {
  return (
    summary.cost_partial_count + summary.cost_unpriced_count + summary.cost_unassessed_count > 0
  );
}

export function canCompareCosts(current: CostCoverage, previous: CostCoverage): boolean {
  return !isCostIncomplete(current) && !isCostIncomplete(previous);
}

export function costCoverageLabels(summary: CostCoverage) {
  const imported =
    summary.cost_priced_count + summary.cost_partial_count + summary.cost_unpriced_count;
  if (imported + summary.cost_unassessed_count === 0) return [];
  return [
    {
      label: 'Priced',
      value: formatNumber(summary.cost_priced_count),
      color: 'var(--color-status-good)',
    },
    ...(summary.cost_partial_count > 0
      ? [
          {
            label: 'Partial',
            value: formatNumber(summary.cost_partial_count),
            color: 'var(--color-status-warning)',
          },
        ]
      : []),
    ...(summary.cost_unpriced_count > 0
      ? [
          {
            label: 'Unpriced',
            value: formatNumber(summary.cost_unpriced_count),
            color: 'var(--color-status-critical)',
          },
        ]
      : []),
    ...(summary.cost_unassessed_count > 0
      ? [
          {
            label: 'Not Assessed',
            value: formatNumber(summary.cost_unassessed_count),
            color: 'var(--color-status-critical)',
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

const COST_STATUS_LABELS: Record<string, string> = {
  priced: 'Priced',
  partial: 'Partial',
  unpriced: 'Unpriced',
};

/** Imported executions carry a pricing status; a missing one means pricing never ran. */
export function importedCostStatusLabel(status: string | undefined): string {
  if (!status) return 'Not Assessed';
  return COST_STATUS_LABELS[status] ?? status;
}
