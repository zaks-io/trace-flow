import type { ModelPricing } from './pricing';

// https://docs.typesafe.ai/models, checked October 5, 2026. Aliases can move to new rates.
export const TYPESAFE_JEV_PRICING = {
  provider: 'typesafe',
  model: 'jev-1.13.0',
  promptCostPerMillion: 42_000,
  completionCostPerMillion: 0,
  source: 'default',
  updatedAt: Date.UTC(2026, 9, 5),
} as const satisfies ModelPricing & { provider: string; model: string };
