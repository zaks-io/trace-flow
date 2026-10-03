import { v } from 'convex/values';

export const contextTierValidator = v.object({
  thresholdTokens: v.number(),
  promptCostPerMillion: v.number(),
  completionCostPerMillion: v.number(),
  cacheReadCostPerMillion: v.optional(v.number()),
  cacheWriteCostPerMillion: v.optional(v.number()),
  cacheWrite1hCostPerMillion: v.optional(v.number()),
  reasoningCostPerMillion: v.optional(v.number()),
});

const modelRateFields = {
  promptCostPerMillion: v.number(),
  completionCostPerMillion: v.number(),
  cacheReadCostPerMillion: v.optional(v.number()),
  cacheWriteCostPerMillion: v.optional(v.number()),
  cacheWrite1hCostPerMillion: v.optional(v.number()),
  reasoningCostPerMillion: v.optional(v.number()),
  contextTier: v.optional(contextTierValidator),
};

export const serviceTierValidator = v.object({
  ...modelRateFields,
  referenceUrl: v.string(),
});

export const serviceTiersValidator = v.object({
  flex: v.optional(serviceTierValidator),
  priority: v.optional(serviceTierValidator),
  batch: v.optional(serviceTierValidator),
});

export const pricingSourceValidator = v.union(
  v.literal('manual'),
  v.literal('openrouter'),
  v.literal('default'),
  v.literal('models.dev'),
);

export const pricingUpsertArgs = {
  provider: v.string(),
  model: v.string(),
  ...modelRateFields,
  serviceTiers: v.optional(serviceTiersValidator),
  source: pricingSourceValidator,
};

export const modelPricingFields = {
  ...pricingUpsertArgs,
  updatedAt: v.number(),
};

export const modelPricingDoc = v.object({
  _id: v.id('modelPricing'),
  _creationTime: v.number(),
  ...modelPricingFields,
});
