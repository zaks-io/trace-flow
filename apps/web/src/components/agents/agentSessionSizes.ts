import type { AgentSessionSizeRow } from './types';

/**
 * Pure derivations over the agent_session_size_distribution row. Keeps the bento cells
 * presentational: bins/bands and the throughput verdict are computed and unit-tested here,
 * not inside JSX. Terminology is standard (messages/tokens per session, throughput), never
 * an invented aggregate.
 */

/** One conversation-size histogram bar (by message count), current vs prior window. */
interface SizeHistogramBin {
  /** Fixed bucket label, e.g. "1–2" or "51+". */
  label: string;
  current: number;
  prior: number;
}

/** A small/medium/large band with its share of conversations and estimated cost. */
export interface SizeBand {
  key: 'small' | 'medium' | 'large';
  label: string;
  /** Inclusive message-count range, for the legend (e.g. "≤5 msgs"). */
  range: string;
  sessions: number;
  priorSessions: number;
  costUsd: number;
  /** Share of current-window conversations 0–1; 0 when there are no sessions. */
  share: number;
}

type ThroughputVerdict = 'many-small' | 'mixed' | 'few-big' | 'none';

export const THROUGHPUT_VERDICT_LABEL: Record<ThroughputVerdict, string> = {
  'many-small': 'Many small',
  mixed: 'Mixed',
  'few-big': 'Few big',
  none: 'No conversations',
};

export function buildSizeHistogram(row: AgentSessionSizeRow): SizeHistogramBin[] {
  return [
    { label: '1–2', current: row.bin_1_2, prior: row.prior_bin_1_2 },
    { label: '3–5', current: row.bin_3_5, prior: row.prior_bin_3_5 },
    { label: '6–10', current: row.bin_6_10, prior: row.prior_bin_6_10 },
    { label: '11–25', current: row.bin_11_25, prior: row.prior_bin_11_25 },
    { label: '26–50', current: row.bin_26_50, prior: row.prior_bin_26_50 },
    { label: '51+', current: row.bin_51_plus, prior: row.prior_bin_51_plus },
  ];
}

export function buildSizeBands(row: AgentSessionSizeRow): SizeBand[] {
  const total = row.session_count;
  const share = (n: number) => (total > 0 ? n / total : 0);
  return [
    {
      key: 'small',
      label: 'Small',
      range: '≤5 msgs',
      sessions: row.small_sessions,
      priorSessions: row.prior_small_sessions,
      costUsd: row.small_cost_usd,
      share: share(row.small_sessions),
    },
    {
      key: 'medium',
      label: 'Medium',
      range: '6–25 msgs',
      sessions: row.medium_sessions,
      priorSessions: row.prior_medium_sessions,
      costUsd: row.medium_cost_usd,
      share: share(row.medium_sessions),
    },
    {
      key: 'large',
      label: 'Large',
      range: '≥26 msgs',
      sessions: row.large_sessions,
      priorSessions: row.prior_large_sessions,
      costUsd: row.large_cost_usd,
      share: share(row.large_sessions),
    },
  ];
}

/**
 * Classify the conversation mix into a plain verdict. "Many small" when small conversations
 * dominate (majority share) and large ones are rare; "Few big" when large conversations carry
 * the work (share or cost majority); otherwise "Mixed". Driven by shares, not magic copy.
 */
export function throughputVerdict(row: AgentSessionSizeRow): ThroughputVerdict {
  const total = row.session_count;
  if (total === 0) return 'none';
  const smallShare = row.small_sessions / total;
  const largeShare = row.large_sessions / total;
  const totalCost = row.small_cost_usd + row.medium_cost_usd + row.large_cost_usd;
  const largeCostShare = totalCost > 0 ? row.large_cost_usd / totalCost : 0;

  if (largeShare >= 0.5 || largeCostShare >= 0.6) return 'few-big';
  if (smallShare >= 0.5 && largeShare < 0.15) return 'many-small';
  return 'mixed';
}

/** Median messages per session, the single-number throughput summary. */
export function medianMessagesPerSession(row: AgentSessionSizeRow): number {
  return row.messages_p50;
}

/**
 * Share of tokens-processed that is genuinely generated (input+output+reasoning) rather than
 * cache-read replay; 0–1. Surfaces how much of the headline token count is cache replay.
 */
export function generatedTokenShare(row: AgentSessionSizeRow): number {
  const processed = row.total_cache_inclusive_tokens;
  if (processed <= 0) return 0;
  return Math.min(1, row.total_generated_tokens / processed);
}
