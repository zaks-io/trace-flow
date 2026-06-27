import { describe, expect, it } from 'vitest';
import { getPricing, type ModelPricing, type PricingStore } from '@trace-flow/pricing';
import { buildPiModelsJson, pricingToPiCost, type PiModelCost } from '../piRunner';

const baseRecord: ModelPricing = {
  promptCostPerMillion: 950_000, // $0.95 / M tokens, stored as microdollars
  completionCostPerMillion: 3_000_000, // $3.00 / M
  cacheReadCostPerMillion: 180_000, // $0.18 / M
  updatedAt: 0,
  source: 'models.dev',
};

describe('Pi model pricing', () => {
  it('converts KV microdollars-per-million into Pi dollars-per-million', () => {
    const cost = pricingToPiCost(baseRecord);
    expect(cost.input).toBeCloseTo(0.95, 10);
    expect(cost.output).toBeCloseTo(3, 10);
    expect(cost.cacheRead).toBeCloseTo(0.18, 10);
  });

  it('falls back unset cache rates to the prompt rate (matches calculateCost)', () => {
    const cost = pricingToPiCost({ ...baseRecord, cacheReadCostPerMillion: undefined });
    expect(cost.cacheRead).toBeCloseTo(0.95, 10);
    expect(cost.cacheWrite).toBeCloseTo(0.95, 10);
  });

  it('bakes the resolved cost into models.json verbatim', () => {
    const cost: PiModelCost = { input: 0.95, output: 3, cacheRead: 0.18, cacheWrite: 0 };
    const json = JSON.parse(buildPiModelsJson('z-ai/glm-5.2', 'http://proxy/api/v1', cost));
    const model = json.providers['traceflow-openrouter'].models[0];
    expect(model.cost).toEqual(cost);
    expect(model.id).toBe('z-ai/glm-5.2');
    expect(model.reasoning).toBe(true);
  });

  it('returns null for an unpriced model so the launcher can fail loud', async () => {
    const emptyStore: PricingStore = { get: async () => null };
    expect(await getPricing(emptyStore, 'openrouter', 'z-ai/glm-5.2')).toBeNull();
  });

  it('matches a model by family prefix when no exact-key entry exists', async () => {
    const store: PricingStore = {
      get: async <T>(key: string) =>
        (key === 'pricing:openrouter:anthropic/claude-opus' ? baseRecord : null) as T | null,
    };
    const dated = await getPricing(store, 'openrouter', 'anthropic/claude-opus-20260101');
    expect(dated?.promptCostPerMillion).toBe(950_000);
  });
});
