import { OTHER_GROUP } from './pivot';
import type { AgentBreakdownRow } from './types';

interface RankedBreakdownEntry {
  /** Raw dimension value (used for cross-filter clicks); OTHER_GROUP for the aggregated tail. */
  value: string;
  amount: number;
}

/**
 * Rank breakdown rows by the active metric (descending). When topN is set and there are
 * more rows than that, the tail collapses into a single OTHER_GROUP entry — the same
 * top-N/Other treatment the hero chart applies to a high-cardinality dimension (repo).
 */
export function rankBreakdown(
  rows: AgentBreakdownRow[],
  metricKey: keyof AgentBreakdownRow,
  topN?: number,
): RankedBreakdownEntry[] {
  const ranked = rows
    .map((row) => ({ value: row.group_value, amount: Number(row[metricKey] ?? 0) }))
    .sort((a, b) => b.amount - a.amount);

  if (topN === undefined || ranked.length <= topN) return ranked;

  const kept = ranked.slice(0, topN);
  const other = ranked.slice(topN).reduce((sum, entry) => sum + entry.amount, 0);
  return [...kept, { value: OTHER_GROUP, amount: other }];
}
