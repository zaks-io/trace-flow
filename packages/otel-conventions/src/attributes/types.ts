/**
 * Cost output shape from the proxy-consumer's pricing module. Defined here so
 * the attribute mapper has a stable contract independent of the pricing impl.
 */
export interface CostBreakdown {
  inputCostMicrodollars: number;
  outputCostMicrodollars: number;
  cacheReadCostMicrodollars: number;
  cacheWriteCostMicrodollars: number;
  reasoningCostMicrodollars: number;
  promptBaselineCostMicrodollars: number;
  cacheImpactCostMicrodollars: number;
  totalCostMicrodollars: number;
}
