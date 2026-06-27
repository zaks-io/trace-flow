import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from '../_generated/server';
import {
  convertOpenRouterModelRates,
  parseOpenRouterModelId,
  type OpenRouterModel,
} from '@trace-flow/pricing';
import { v } from 'convex/values';
import { requireAuthenticated } from '../auth/auth';
import { requireAdmin } from '../auth/users';
import { internal } from '../_generated/api';
import { DEFAULT_PRICING } from './defaultPricing';

async function requireAdminAction(ctx: ActionCtx) {
  await requireAuthenticated(ctx);
  const isAdmin = await ctx.runQuery(internal.auth.users.isAdminInternal);
  if (!isAdmin) throw new Error('Admin access required');
}

/** Tier rates that replace the base rates once a message's input context reaches `thresholdTokens`. */
const contextTierValidator = v.object({
  thresholdTokens: v.number(),
  promptCostPerMillion: v.number(),
  completionCostPerMillion: v.number(),
  cacheReadCostPerMillion: v.optional(v.number()),
  cacheWriteCostPerMillion: v.optional(v.number()),
  cacheWrite1hCostPerMillion: v.optional(v.number()),
  reasoningCostPerMillion: v.optional(v.number()),
});

const pricingSourceValidator = v.union(
  v.literal('manual'),
  v.literal('openrouter'),
  v.literal('default'),
  v.literal('models.dev'),
);

type PricingSource = 'manual' | 'openrouter' | 'default' | 'models.dev';

interface ContextTierPricing {
  thresholdTokens: number;
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  cacheWrite1hCostPerMillion?: number;
  reasoningCostPerMillion?: number;
}

interface ModelPricingWrite {
  provider: string;
  model: string;
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  cacheWrite1hCostPerMillion?: number;
  reasoningCostPerMillion?: number;
  contextTier?: ContextTierPricing;
  source: PricingSource;
}

/** Shared upsert input — the writable pricing fields, reused by `upsert` and `upsertInternal`. */
const pricingUpsertArgs = {
  provider: v.string(),
  model: v.string(),
  promptCostPerMillion: v.number(),
  completionCostPerMillion: v.number(),
  cacheReadCostPerMillion: v.optional(v.number()),
  cacheWriteCostPerMillion: v.optional(v.number()),
  cacheWrite1hCostPerMillion: v.optional(v.number()),
  reasoningCostPerMillion: v.optional(v.number()),
  contextTier: v.optional(contextTierValidator),
  source: pricingSourceValidator,
};

const modelPricingDoc = v.object({
  _id: v.id('modelPricing'),
  _creationTime: v.number(),
  provider: v.string(),
  model: v.string(),
  promptCostPerMillion: v.number(),
  completionCostPerMillion: v.number(),
  cacheReadCostPerMillion: v.optional(v.number()),
  cacheWriteCostPerMillion: v.optional(v.number()),
  cacheWrite1hCostPerMillion: v.optional(v.number()),
  reasoningCostPerMillion: v.optional(v.number()),
  contextTier: v.optional(contextTierValidator),
  source: pricingSourceValidator,
  updatedAt: v.number(),
});

async function writeModelPricing(ctx: MutationCtx, args: ModelPricingWrite) {
  const existing = await ctx.db
    .query('modelPricing')
    .withIndex('by_provider_model', (q) => q.eq('provider', args.provider).eq('model', args.model))
    .first();

  const data = {
    provider: args.provider,
    model: args.model,
    promptCostPerMillion: args.promptCostPerMillion,
    completionCostPerMillion: args.completionCostPerMillion,
    cacheReadCostPerMillion: args.cacheReadCostPerMillion,
    cacheWriteCostPerMillion: args.cacheWriteCostPerMillion,
    cacheWrite1hCostPerMillion: args.cacheWrite1hCostPerMillion,
    reasoningCostPerMillion: args.reasoningCostPerMillion,
    contextTier: args.contextTier,
    source: args.source,
    updatedAt: Date.now(),
  };

  if (existing) {
    await ctx.db.patch(existing._id, data);
    return existing._id;
  }

  return ctx.db.insert('modelPricing', data);
}

export const list = query({
  args: {
    provider: v.optional(v.string()),
  },
  returns: v.array(modelPricingDoc),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);

    const { provider } = args;
    if (provider) {
      return ctx.db
        .query('modelPricing')
        .withIndex('by_provider', (q) => q.eq('provider', provider))
        .collect();
    }
    return ctx.db.query('modelPricing').collect();
  },
});

export const get = query({
  args: {
    provider: v.string(),
    model: v.string(),
  },
  returns: v.union(modelPricingDoc, v.null()),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);

    return ctx.db
      .query('modelPricing')
      .withIndex('by_provider_model', (q) =>
        q.eq('provider', args.provider).eq('model', args.model),
      )
      .first();
  },
});

export const getInternal = internalQuery({
  args: {
    provider: v.string(),
    model: v.string(),
  },
  returns: v.union(modelPricingDoc, v.null()),
  handler: async (ctx, args) => {
    return ctx.db
      .query('modelPricing')
      .withIndex('by_provider_model', (q) =>
        q.eq('provider', args.provider).eq('model', args.model),
      )
      .first();
  },
});

export const upsert = mutation({
  args: pricingUpsertArgs,
  returns: v.id('modelPricing'),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const id = await writeModelPricing(ctx, args);
    await ctx.scheduler.runAfter(0, internal.billing.pricingSync.syncToKV, {
      provider: args.provider,
      model: args.model,
    });
    return id;
  },
});

export const upsertInternal = internalMutation({
  args: pricingUpsertArgs,
  returns: v.id('modelPricing'),
  handler: async (ctx, args) => {
    return writeModelPricing(ctx, args);
  },
});

export const remove = mutation({
  args: {
    id: v.id('modelPricing'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const pricing = await ctx.db.get(args.id);
    if (!pricing) {
      throw new Error('Pricing not found');
    }

    await ctx.db.delete(args.id);
    await ctx.scheduler.runAfter(0, internal.billing.pricingSync.deleteFromKV, {
      provider: pricing.provider,
      model: pricing.model,
    });
  },
});

export const syncAllToKV = action({
  args: {},
  returns: v.object({ synced: v.number() }),
  handler: async (ctx) => {
    await requireAdminAction(ctx);

    const allPricing = await ctx.runQuery(internal.billing.modelPricing.listAll);
    let synced = 0;

    for (const pricing of allPricing) {
      await ctx.runAction(internal.billing.pricingSync.syncToKV, {
        provider: pricing.provider,
        model: pricing.model,
      });
      synced++;
    }

    return { synced };
  },
});

export const listAll = internalQuery({
  returns: v.array(modelPricingDoc),
  handler: async (ctx) => {
    return ctx.db.query('modelPricing').collect();
  },
});

interface _OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export const importFromOpenRouter = action({
  args: {},
  returns: v.object({ imported: v.number() }),
  handler: async (ctx) => {
    await requireAdminAction(ctx);

    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    let imported = 0;

    for (const orModel of data.data) {
      if (!parseOpenRouterModelId(orModel.id)) continue;
      const converted = convertOpenRouterModelRates(orModel);

      await ctx.runMutation(internal.billing.modelPricing.upsertInternal, {
        provider: 'openrouter',
        model: orModel.id,
        promptCostPerMillion: converted.promptCostPerMillion,
        completionCostPerMillion: converted.completionCostPerMillion,
        cacheReadCostPerMillion: converted.cacheReadCostPerMillion,
        cacheWriteCostPerMillion: converted.cacheWriteCostPerMillion,
        reasoningCostPerMillion: converted.reasoningCostPerMillion,
        source: 'openrouter',
      });
      imported++;
    }

    return { imported };
  },
});

/**
 * Import a single OpenRouter model's rate from the live catalog and push it to the worker KV.
 * Internal so it can run unauthenticated (e.g. seeding a newly-configured analyst model whose
 * daily import hasn't landed yet) using the same OpenRouter conversion as the bulk import.
 */
export const importOneFromOpenRouterInternal = internalAction({
  args: { model: v.string() },
  returns: v.object({ imported: v.boolean() }),
  handler: async (ctx, args) => {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }
    const data = await response.json();
    const orModel = (data.data as OpenRouterModel[]).find((m) => m.id === args.model);
    if (!orModel || !parseOpenRouterModelId(orModel.id)) return { imported: false };

    const converted = convertOpenRouterModelRates(orModel);
    await ctx.runMutation(internal.billing.modelPricing.upsertInternal, {
      provider: 'openrouter',
      model: orModel.id,
      promptCostPerMillion: converted.promptCostPerMillion,
      completionCostPerMillion: converted.completionCostPerMillion,
      cacheReadCostPerMillion: converted.cacheReadCostPerMillion,
      cacheWriteCostPerMillion: converted.cacheWriteCostPerMillion,
      reasoningCostPerMillion: converted.reasoningCostPerMillion,
      source: 'openrouter',
    });
    await ctx.runAction(internal.billing.pricingSync.syncToKV, {
      provider: 'openrouter',
      model: orModel.id,
    });
    return { imported: true };
  },
});

export const syncDefaults = action({
  args: {},
  returns: v.object({ synced: v.number() }),
  handler: async (ctx) => {
    await requireAdminAction(ctx);

    let synced = 0;
    for (const pricing of DEFAULT_PRICING) {
      await ctx.runMutation(internal.billing.modelPricing.upsertInternal, {
        provider: pricing.provider,
        model: pricing.model,
        promptCostPerMillion: pricing.promptCostPerMillion,
        completionCostPerMillion: pricing.completionCostPerMillion,
        cacheReadCostPerMillion: pricing.cacheReadCostPerMillion,
        cacheWriteCostPerMillion: pricing.cacheWriteCostPerMillion,
        cacheWrite1hCostPerMillion: pricing.cacheWrite1hCostPerMillion,
        source: 'default',
      });
      synced++;
    }

    // Sync all pricing to KV (including any existing entries)
    const allPricing = await ctx.runQuery(internal.billing.modelPricing.listAll);
    for (const p of allPricing) {
      await ctx.runAction(internal.billing.pricingSync.syncToKV, {
        provider: p.provider,
        model: p.model,
      });
    }

    return { synced };
  },
});

// --- models.dev import -------------------------------------------------------------------------
//
// models.dev is the upstream catalog (https://models.dev/api.json). Top-level keys are provider IDs;
// most are gateways re-listing the same models, so we pin ONLY the first parties that carry true
// economics. Prices are published as dollars per million tokens — our catalog stores microdollars.

const MODELS_DEV_API_URL = 'https://models.dev/api.json';

// Bound the fetch so a hung models.dev never wedges the daily cron action.
const MODELS_DEV_FETCH_TIMEOUT_MS = 15_000;

/** models.dev re-lists ~25 gateway providers; pin only the first parties (ADR + ROADMAP watch-item). */
const MODELS_DEV_FIRST_PARTY_PROVIDERS = ['anthropic', 'openai'] as const;

interface ModelsDevTierCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  tier: { type: string; size: number };
}

interface ModelsDevCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: ModelsDevTierCost[];
}

interface ModelsDevModel {
  cost?: ModelsDevCost;
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevApi = Record<string, ModelsDevProvider>;

interface ConvertedTier {
  thresholdTokens: number;
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
}

interface ConvertedPricing {
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  contextTier?: ConvertedTier;
}

/**
 * models.dev publishes dollars per million tokens; our catalog stores microdollars per million.
 * Returns null for a non-finite or negative rate so untrusted JSON can't corrupt a pricing row (and
 * every downstream cost) with NaN/Infinity/negative microdollars.
 */
function dollarsToMicrodollars(dollarsPerMillion: number): number | null {
  if (!Number.isFinite(dollarsPerMillion) || dollarsPerMillion < 0) return null;
  return Math.round(dollarsPerMillion * 1_000_000);
}

/** Optional rate: a present-but-invalid value is dropped (undefined), an absent one stays absent. */
function optionalMicrodollars(dollarsPerMillion: number | undefined): number | undefined {
  if (dollarsPerMillion === undefined) return undefined;
  return dollarsToMicrodollars(dollarsPerMillion) ?? undefined;
}

/**
 * Converts one models.dev model entry to our microdollar pricing record, mapping a
 * `tier.type === 'context'` rate set (e.g. `gpt-5.5` above 272k tokens) onto `contextTier`. Returns
 * null for entries without a `cost` block (e.g. the openai image models) or with an invalid required
 * `input`/`output` rate, so the caller skips them rather than storing a misleading or corrupt rate.
 * Exported for the headless conversion unit test.
 */
export function convertModelsDevModel(model: ModelsDevModel): ConvertedPricing | null {
  const cost = model.cost;
  if (!cost) return null;

  const promptCostPerMillion = dollarsToMicrodollars(cost.input);
  const completionCostPerMillion = dollarsToMicrodollars(cost.output);
  if (promptCostPerMillion === null || completionCostPerMillion === null) return null;

  const contextTierCost = cost.tiers?.find((t) => t.tier.type === 'context');
  const tierPrompt = contextTierCost ? dollarsToMicrodollars(contextTierCost.input) : null;
  const tierCompletion = contextTierCost ? dollarsToMicrodollars(contextTierCost.output) : null;
  // Drop a context tier whose required rates are invalid rather than store a corrupt threshold rate.
  const contextTier: ConvertedTier | undefined =
    contextTierCost && tierPrompt !== null && tierCompletion !== null
      ? {
          thresholdTokens: contextTierCost.tier.size,
          promptCostPerMillion: tierPrompt,
          completionCostPerMillion: tierCompletion,
          cacheReadCostPerMillion: optionalMicrodollars(contextTierCost.cache_read),
          cacheWriteCostPerMillion: optionalMicrodollars(contextTierCost.cache_write),
        }
      : undefined;

  return {
    promptCostPerMillion,
    completionCostPerMillion,
    cacheReadCostPerMillion: optionalMicrodollars(cost.cache_read),
    cacheWriteCostPerMillion: optionalMicrodollars(cost.cache_write),
    contextTier,
  };
}

/**
 * Daily-cron import: refresh first-party `anthropic`/`openai` pricing from models.dev. Each model is
 * stored verbatim by its models.dev key (which publishes both dated and undated family keys, so
 * `getPricing`'s exact-then-date-stripped lookup resolves either form), then pushed to the
 * worker-facing KV catalog so the agent consumer prices against the fresh rate. A KV-sync failure
 * surfaces as the 2f priced-coverage% alert, never silent staleness. `codex-auto-review` and the
 * Cursor house models are intentionally NOT aliased here — they carry no first-party rate and resolve
 * null (counted in the coverage denominator), per the ADR.
 */
export const importFromModelsDevInternal = internalAction({
  args: {},
  returns: v.object({ imported: v.number(), skipped: v.number() }),
  handler: async (ctx) => {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: AbortSignal.timeout(MODELS_DEV_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`models.dev API error: ${response.status}`);
    }

    const data: ModelsDevApi = await response.json();
    let imported = 0;
    let skipped = 0;

    for (const provider of MODELS_DEV_FIRST_PARTY_PROVIDERS) {
      const models = data[provider]?.models;
      if (!models) continue;

      for (const [model, entry] of Object.entries(models)) {
        const converted = convertModelsDevModel(entry);
        if (!converted) {
          skipped++;
          continue;
        }

        await ctx.runMutation(internal.billing.modelPricing.upsertInternal, {
          provider,
          model,
          promptCostPerMillion: converted.promptCostPerMillion,
          completionCostPerMillion: converted.completionCostPerMillion,
          cacheReadCostPerMillion: converted.cacheReadCostPerMillion,
          cacheWriteCostPerMillion: converted.cacheWriteCostPerMillion,
          contextTier: converted.contextTier,
          source: 'models.dev',
        });
        await ctx.scheduler.runAfter(0, internal.billing.pricingSync.syncToKV, { provider, model });
        imported++;
      }
    }

    return { imported, skipped };
  },
});

export const importFromModelsDev = action({
  args: {},
  returns: v.object({ imported: v.number(), skipped: v.number() }),
  handler: async (ctx) => {
    await requireAdminAction(ctx);
    return ctx.runAction(internal.billing.modelPricing.importFromModelsDevInternal, {});
  },
});
