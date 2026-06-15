import { formatCurrency, formatNumber } from '@/lib/format';
import type { AgentCostDistributionRow } from './types';

/**
 * Pure derivations over the agent_session_cost_distribution row. Conversations are measured in
 * COST and TOKENS only — message counts are deliberately not a distribution axis here, because
 * they hide the spend that actually matters. Cost is the default axis; tokens are a toggle.
 * Keeps the bento cells presentational: histogram bins, percentiles, and the skew summary are
 * computed and unit-tested here, not inside JSX.
 */

/** The two axes a conversation distribution can be measured on. Cost is the default. */
export type DistributionAxis = 'cost' | 'tokens';

/** One histogram bar: a magnitude band with its conversation count and total spend/tokens. */
interface DistributionBin {
  /** Fixed bucket label, e.g. "$0.10–1" or "10k–50k". */
  label: string;
  /** Number of conversations that fell in this band (current window). */
  count: number;
  /** Total cost (USD) or generated tokens within the band — where the magnitude concentrates. */
  total: number;
}

/** Per-conversation percentiles for the active axis, plus the prior-window p50 for comparison. */
interface DistributionPercentiles {
  p50: number;
  p90: number;
  p95: number;
  max: number;
  priorP50: number;
}

/** The headline skew fact: how concentrated spend is in the priciest conversations. */
interface SkewSummary {
  /** Count of conversations in the priciest 10%. */
  topCount: number;
  /** Total spend carried by that top 10% (USD). */
  topCostUsd: number;
  /** Share of total spend carried by the top 10%, 0–1. 0 when there is no spend. */
  topCostShare: number;
  /** p95 ÷ p50 of per-conversation cost; how stretched the tail is. 0 when p50 is 0. */
  p95OverP50: number;
}

/** One plotted point on the concentration (Lorenz) curve. Both axes are cumulative shares 0–1. */
export interface ConcentrationPoint {
  /** Cumulative share of conversations, priciest-first. */
  convPct: number;
  /** Cumulative share of total spend at that conversation share. */
  costPct: number;
}

/**
 * The bin-free spend-concentration curve and its derived facts. Every number here comes from the
 * sorted per-conversation cost array — no chosen dollar or percentile cutpoints. `points` plots
 * cumulative spend share against cumulative conversation share (priciest-first), so the curve
 * bows above the diagonal; the area of that bulge is the Gini coefficient.
 */
export interface ConcentrationCurve {
  points: ConcentrationPoint[];
  /** 0 = spend even across all conversations, 1 = all in one. */
  gini: number;
  /** Conversations whose combined spend reaches half the total (the "half is in N" fact). */
  halfSpendCount: number;
  /** Conversations in the priciest 10% (mirrors the skew headline as a curve point). */
  topCount: number;
  /** Share of total spend carried by that priciest 10%, 0–1. */
  topCostShare: number;
  totalCost: number;
  sessionCount: number;
}

/**
 * Reads the pipe's Lorenz arrays + derived scalars into a drawable curve. The pipe already sorts
 * conversations priciest-first and guards the empty case (no row), but we re-clamp shares to 0–1
 * and drop any malformed point so the chart never renders a non-monotonic or out-of-range curve.
 */
export function buildConcentrationCurve(row: AgentCostDistributionRow): ConcentrationCurve {
  const convPcts = Array.isArray(row.lorenz_conv_pct) ? row.lorenz_conv_pct : [];
  const costPcts = Array.isArray(row.lorenz_cost_pct) ? row.lorenz_cost_pct : [];
  const clamp = (value: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

  const points: ConcentrationPoint[] = [];
  const pairCount = Math.min(convPcts.length, costPcts.length);
  for (let i = 0; i < pairCount; i++) {
    points.push({ convPct: clamp(convPcts[i]), costPct: clamp(costPcts[i]) });
  }

  const topCostShare =
    row.total_cost_usd > 0 ? Math.min(1, row.top_10pct_cost_usd / row.total_cost_usd) : 0;

  return {
    points,
    gini: clamp(row.gini),
    halfSpendCount: row.half_spend_conv_count,
    topCount: row.top_10pct_session_count,
    topCostShare,
    totalCost: row.total_cost_usd,
    sessionCount: row.session_count,
  };
}

const AXIS_LABEL: Record<DistributionAxis, string> = {
  cost: 'Cost',
  tokens: 'Tokens generated',
};

export function axisLabel(axis: DistributionAxis): string {
  return AXIS_LABEL[axis];
}

/** Format a value on the active axis: currency for cost, plain count for tokens. */
export function formatAxisValue(axis: DistributionAxis, value: number): string {
  return axis === 'cost' ? formatCurrency(value) : formatNumber(value);
}

/**
 * The conversation-magnitude histogram for the active axis. Cost bands are spend tiers
 * (<$0.10 … $20+); token bands are generated-token tiers (<10k … 1M+). Each bar carries both
 * the conversation count and the total magnitude so the cell can show count or summed spend.
 */
export function buildDistributionBins(
  row: AgentCostDistributionRow,
  axis: DistributionAxis,
): DistributionBin[] {
  if (axis === 'cost') {
    return [
      { label: '<$0.10', count: row.cost_bin_under_10c, total: row.cost_sum_under_10c },
      { label: '$0.10–1', count: row.cost_bin_10c_1, total: row.cost_sum_10c_1 },
      { label: '$1–5', count: row.cost_bin_1_5, total: row.cost_sum_1_5 },
      { label: '$5–20', count: row.cost_bin_5_20, total: row.cost_sum_5_20 },
      { label: '$20+', count: row.cost_bin_20_plus, total: row.cost_sum_20_plus },
    ];
  }
  return [
    { label: '<10k', count: row.token_bin_under_10k, total: row.token_sum_under_10k },
    { label: '10k–50k', count: row.token_bin_10k_50k, total: row.token_sum_10k_50k },
    { label: '50k–200k', count: row.token_bin_50k_200k, total: row.token_sum_50k_200k },
    { label: '200k–1M', count: row.token_bin_200k_1m, total: row.token_sum_200k_1m },
    { label: '1M+', count: row.token_bin_1m_plus, total: row.token_sum_1m_plus },
  ];
}

/** Per-conversation percentiles for the active axis. Tokens use the generated (real-work) axis. */
export function buildPercentiles(
  row: AgentCostDistributionRow,
  axis: DistributionAxis,
): DistributionPercentiles {
  if (axis === 'cost') {
    return {
      p50: row.cost_p50,
      p90: row.cost_p90,
      p95: row.cost_p95,
      max: row.cost_max,
      priorP50: row.prior_cost_p50,
    };
  }
  return {
    p50: row.generated_tokens_p50,
    p90: row.generated_tokens_p90,
    p95: row.generated_tokens_p95,
    max: row.generated_tokens_max,
    priorP50: row.prior_generated_tokens_p50,
  };
}

/**
 * The spend-skew summary. The point the user cares about: a few conversations carry most of
 * the cost. Reports the top-10% concentration (count + spend + share) and the p95/p50 stretch.
 */
export function buildSkewSummary(row: AgentCostDistributionRow): SkewSummary {
  const topCostShare =
    row.total_cost_usd > 0 ? Math.min(1, row.top_10pct_cost_usd / row.total_cost_usd) : 0;
  const p95OverP50 = row.cost_p50 > 0 ? row.cost_p95 / row.cost_p50 : 0;
  return {
    topCount: row.top_10pct_session_count,
    topCostUsd: row.top_10pct_cost_usd,
    topCostShare,
    p95OverP50,
  };
}

/**
 * Share of tokens-processed that is genuinely generated (input+output+reasoning) rather than
 * cache-read replay; 0–1. Surfaces how much of the headline token count is cache replay.
 */
export function generatedTokenShare(row: AgentCostDistributionRow): number {
  const processed = row.total_cache_inclusive_tokens;
  if (processed <= 0) return 0;
  return Math.min(1, row.total_generated_tokens / processed);
}
