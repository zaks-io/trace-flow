import type { AgentCostByDepthRow } from './types';

/**
 * Shaped depth series for the two stacked charts. Each point is one conversation depth (raw
 * turn_index); `band` is the p25→p75 height the area renders, plotted on top of `p25` so the
 * stacked area paints the inter-quartile body. `costElasticity`/`contextElasticity` are the
 * window-level log-log slopes (identical on every pipe row) lifted out once.
 */
export interface DepthPoint {
  depth: number;
  sampleCount: number;
  costP25: number;
  costP50: number;
  costP75: number;
  costP95: number;
  costBand: number;
  contextP25: number;
  contextP50: number;
  contextP75: number;
  contextP95: number;
  contextBand: number;
}

interface DepthSeries {
  points: DepthPoint[];
  /** Deepest CHARTED depth (the x-axis extent = deepest well-sampled depth). */
  chartedMaxDepth: number;
  /** Deepest turn observed at all, charted or not — for the honest "deepest seen" footnote. */
  observedMaxDepth: number;
  /** Sample threshold a depth must clear to be charted/fit — named in the footnote, not hidden. */
  minDepthSamples: number;
  /** Depths set aside as too sparse to chart (below min_depth_samples), and the turns they held. */
  pooledDepthCount: number;
  pooledTurnCount: number;
  costElasticity: number;
  contextElasticity: number;
  costFitPoints: number;
  contextFitPoints: number;
  fitSampled: boolean;
  /** Multiplier on per-turn cost for each doubling of depth: 2^costElasticity. */
  costDoublingFactor: number;
  contextDoublingFactor: number;
}

/**
 * Reshape the per-depth rows into chart points; returns null when there is nothing to plot. Only
 * well-sampled depths (>= min_depth_samples conversations, the same threshold the fit uses) become
 * points, so a sparse deep tail of 1-2 conversations cannot bury the trend; the pooled-out depths
 * are still reported as scalars for an honest footnote. The window-level scalars are identical on
 * every row, so they are read off the first row.
 */
export function buildDepthSeries(rows: AgentCostByDepthRow[]): DepthSeries | null {
  if (rows.length === 0) return null;
  const first = rows[0];
  const points = rows
    .filter((r) => r.well_sampled === 1)
    .sort((a, b) => a.depth - b.depth)
    .map((r) => ({
      depth: r.depth,
      sampleCount: r.sample_count,
      costP25: r.cost_p25,
      costP50: r.cost_p50,
      costP75: r.cost_p75,
      costP95: r.cost_p95,
      costBand: Math.max(0, r.cost_p75 - r.cost_p25),
      contextP25: r.context_p25,
      contextP50: r.context_p50,
      contextP75: r.context_p75,
      contextP95: r.context_p95,
      contextBand: Math.max(0, r.context_p75 - r.context_p25),
    }));
  return {
    points,
    chartedMaxDepth: first.charted_max_depth,
    observedMaxDepth: first.observed_max_depth,
    minDepthSamples: first.min_depth_samples,
    pooledDepthCount: first.pooled_depth_count,
    pooledTurnCount: first.pooled_turn_count,
    costElasticity: first.cost_elasticity,
    contextElasticity: first.context_elasticity,
    costFitPoints: first.cost_fit_points,
    contextFitPoints: first.context_fit_points,
    fitSampled: first.fit_sampled === 1,
    costDoublingFactor: 2 ** first.cost_elasticity,
    contextDoublingFactor: 2 ** first.context_elasticity,
  };
}

type ElasticityVerdict = 'flat' | 'linear' | 'accelerating' | 'declining';

/**
 * Bucket an elasticity into the runaway-detector readout. The boundaries are the natural
 * breakpoints of the model, not tuned thresholds: 0 = no growth, 1 = exactly linear (each
 * doubling of depth doubles per-turn cost — history re-paid every turn). Below ~linear the cost
 * is dominated by a few large turns rather than depth; above linear it accelerates (the loop).
 * A small dead-band around those anchors keeps a near-zero or near-one fit from flipping labels
 * on noise; it is presentation rounding, not a hidden cutoff (the raw slope is always shown).
 */
export function classifyElasticity(elasticity: number): ElasticityVerdict {
  if (elasticity < -0.15) return 'declining';
  if (elasticity < 0.15) return 'flat';
  if (elasticity <= 1.15) return 'linear';
  return 'accelerating';
}

const VERDICT_GLOSS: Record<ElasticityVerdict, string> = {
  declining: 'later turns cost less — early turns carry the spend, not depth',
  flat: 'per-turn cost barely grows with depth — a few large turns, not creep',
  linear: 'per-turn cost grows about in step with depth — history re-paid each turn',
  accelerating: 'per-turn cost grows faster than depth — the runaway signal; compact sooner',
};

export function elasticityGloss(elasticity: number): string {
  return VERDICT_GLOSS[classifyElasticity(elasticity)];
}
