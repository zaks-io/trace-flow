import type { RequestStatsRow } from './types';

type CostShapeVerdict = 'uniform' | 'moderate' | 'fat-tailed' | 'insufficient';

/**
 * Classify a slice's per-request cost shape from its bias-corrected Gini. The thresholds are a
 * presentation aid, not new statistics — the Gini itself is the fact. Below MIN_REQUESTS the
 * shape is not characterized (a Gini over a handful of requests is noise).
 */
export const MIN_REQUESTS = 20;

export function classifyCostShape(
  row: Pick<RequestStatsRow, 'request_count' | 'gini'>,
): CostShapeVerdict {
  if (row.request_count < MIN_REQUESTS) return 'insufficient';
  if (row.gini < 0.3) return 'uniform';
  if (row.gini < 0.6) return 'moderate';
  return 'fat-tailed';
}

/**
 * The one-line optimization read. Uniform -> the cost is the per-call cost; the lever is the
 * prompt/model. Fat-tailed -> a few calls dominate; the lever is the outliers. half_spend is the
 * smallest number of requests carrying half the slice's spend, which makes "go hunt N calls"
 * concrete.
 */
export function costShapeGloss(
  row: Pick<RequestStatsRow, 'request_count' | 'gini' | 'half_spend_request_count'>,
): string {
  const verdict = classifyCostShape(row);
  switch (verdict) {
    case 'insufficient':
      return `Too few requests (${row.request_count}) to characterize cost shape — need ${MIN_REQUESTS}+.`;
    case 'uniform':
      return 'Cost is uniform across requests — to optimize, lower the per-call cost (prompt or model).';
    case 'moderate':
      return `Cost is moderately concentrated — ${row.half_spend_request_count} requests carry half the spend.`;
    case 'fat-tailed':
      return `Cost is fat-tailed — just ${row.half_spend_request_count} requests carry half the spend; hunt the outliers.`;
  }
}

interface CostBucketBar {
  label: string;
  lo: number;
  hi: number;
  count: number;
  sum: number;
}

/** Zip the parallel decile-bucket arrays from the pipe into drawable bars (sum = where the money is). */
export function buildCostBuckets(row: RequestStatsRow): CostBucketBar[] {
  const { cost_bucket_lo, cost_bucket_hi, cost_bucket_count, cost_bucket_sum } = row;
  if (!cost_bucket_lo?.length) return [];
  return cost_bucket_lo.map((lo, i) => ({
    lo,
    hi: cost_bucket_hi[i],
    count: cost_bucket_count[i],
    sum: cost_bucket_sum[i],
    label: `$${lo.toFixed(lo < 0.01 ? 4 : 2)}–$${cost_bucket_hi[i].toFixed(cost_bucket_hi[i] < 0.01 ? 4 : 2)}`,
  }));
}

/** Lorenz points (x = cumulative request share, y = cumulative cost share) for the area chart. */
export function buildLorenzPoints(
  row: RequestStatsRow,
): Array<{ requestPct: number; costPct: number }> {
  const xs = row.lorenz_request_pct ?? [];
  const ys = row.lorenz_cost_pct ?? [];
  return xs.map((x, i) => ({ requestPct: x, costPct: ys[i] ?? 0 }));
}
