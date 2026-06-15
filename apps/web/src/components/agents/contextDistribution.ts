import type { AgentContextHealthRow } from './types';

/** Even 100K bins across the 0-1M model ceiling; the last bin is a >=900K catch-all. */
const CONTEXT_BIN_WIDTH = 100_000;
export const CONTEXT_BIN_COUNT = 10;

interface ContextBin {
  /** Lower edge of the bin, in tokens. */
  start: number;
  /** Short axis label, e.g. "0", "100K", "900K+". */
  label: string;
  count: number;
}

function binLabel(index: number): string {
  const startK = index * 100;
  if (index === CONTEXT_BIN_COUNT - 1) return `${startK}K+`;
  return startK === 0 ? '0' : `${startK}K`;
}

/**
 * The per-turn context histogram as drawable bins. Reads the flat `context_hist_bin_N` /
 * `prior_context_hist_bin_N` columns the pipe emits — bin edges are presentation, not
 * thresholds, so nothing here gates a headline number.
 */
export function buildContextBins(row: AgentContextHealthRow): ContextBin[] {
  const bins: ContextBin[] = [];
  for (let i = 0; i < CONTEXT_BIN_COUNT; i++) {
    const current = row[`context_hist_bin_${i}` as keyof AgentContextHealthRow];
    bins.push({
      start: i * CONTEXT_BIN_WIDTH,
      label: binLabel(i),
      count: typeof current === 'number' ? current : 0,
    });
  }
  return bins;
}
