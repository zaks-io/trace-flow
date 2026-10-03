import { formatNumber, formatPercent } from '@/lib/format';
import { isCostUnknown } from './costCoverage';
import type { UpstreamAccountRow } from './types';

/** Every execution lacked usage, so token sums would read as a fabricated zero. */
function isUsageUnavailable(
  row: Pick<UpstreamAccountRow, 'usage_missing_count' | 'request_count'>,
) {
  return row.request_count > 0 && row.usage_missing_count === row.request_count;
}

export function tokenCell(
  row: Pick<UpstreamAccountRow, 'usage_missing_count' | 'request_count'>,
  value: number,
): string {
  return isUsageUnavailable(row) ? '-' : formatNumber(value);
}

/** Reasoning is part of output, so it is shown as a share rather than a separate bucket. */
export function reasoningShare(
  row: Pick<
    UpstreamAccountRow,
    'usage_missing_count' | 'request_count' | 'output_tokens' | 'reasoning_tokens'
  >,
): string {
  if (isUsageUnavailable(row) || row.output_tokens === 0) return '-';
  return formatPercent((row.reasoning_tokens / row.output_tokens) * 100);
}

/** Partial gaps stay visible next to the sums they qualify. */
export function usageGapNote(
  row: Pick<UpstreamAccountRow, 'usage_missing_count' | 'request_count' | 'unclassified_tokens'>,
): string | null {
  const notes: string[] = [];
  if (row.usage_missing_count > 0 && !isUsageUnavailable(row)) {
    notes.push(`${formatNumber(row.usage_missing_count)} without usage`);
  }
  if (row.unclassified_tokens > 0) {
    notes.push(`${formatNumber(row.unclassified_tokens)} unclassified`);
  }
  return notes.length > 0 ? notes.join(', ') : null;
}

export function estimatedCost(row: UpstreamAccountRow): number | null {
  return isCostUnknown(row) ? null : row.total_cost_usd;
}

export function costGapNote(row: UpstreamAccountRow): string | null {
  const notes = [
    [row.cost_partial_count, 'partial'],
    [row.cost_unpriced_count, 'unpriced'],
    [row.cost_unassessed_count, 'not assessed'],
  ] as const;
  const parts = notes
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${formatNumber(count)} ${label}`);
  if (row.cost_coverage_ratio !== null && row.cost_coverage_ratio < 1) {
    parts.push(`${formatPercent(row.cost_coverage_ratio * 100)} of tokens priced`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}
