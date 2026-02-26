import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from './_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from './auth';
import { requireAdmin } from './users';
import { internal } from './_generated/api';
import { DEFAULT_PRICING } from './defaultPricing';

async function requireAdminAction(ctx: ActionCtx) {
  await requireTraceFlowRole(ctx);
  const isAdmin = await ctx.runQuery(internal.users.isAdminInternal);
  if (!isAdmin) throw new Error('Admin access required');
}

export const list = query({
  args: {
    provider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);

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
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);

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
  args: {
    provider: v.string(),
    model: v.string(),
    promptCostPerMillion: v.number(),
    completionCostPerMillion: v.number(),
    cacheReadCostPerMillion: v.optional(v.number()),
    cacheWriteCostPerMillion: v.optional(v.number()),
    cacheWrite1hCostPerMillion: v.optional(v.number()),
    reasoningCostPerMillion: v.optional(v.number()),
    source: v.union(v.literal('manual'), v.literal('openrouter'), v.literal('default')),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const existing = await ctx.db
      .query('modelPricing')
      .withIndex('by_provider_model', (q) =>
        q.eq('provider', args.provider).eq('model', args.model),
      )
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
      source: args.source,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
      await ctx.scheduler.runAfter(0, internal.pricingSync.syncToKV, {
        provider: args.provider,
        model: args.model,
      });
      return existing._id;
    }

    const id = await ctx.db.insert('modelPricing', data);
    await ctx.scheduler.runAfter(0, internal.pricingSync.syncToKV, {
      provider: args.provider,
      model: args.model,
    });
    return id;
  },
});

export const upsertInternal = internalMutation({
  args: {
    provider: v.string(),
    model: v.string(),
    promptCostPerMillion: v.number(),
    completionCostPerMillion: v.number(),
    cacheReadCostPerMillion: v.optional(v.number()),
    cacheWriteCostPerMillion: v.optional(v.number()),
    cacheWrite1hCostPerMillion: v.optional(v.number()),
    reasoningCostPerMillion: v.optional(v.number()),
    source: v.union(v.literal('manual'), v.literal('openrouter'), v.literal('default')),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('modelPricing')
      .withIndex('by_provider_model', (q) =>
        q.eq('provider', args.provider).eq('model', args.model),
      )
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
      source: args.source,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
      return existing._id;
    }

    return await ctx.db.insert('modelPricing', data);
  },
});

export const remove = mutation({
  args: {
    id: v.id('modelPricing'),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const pricing = await ctx.db.get(args.id);
    if (!pricing) {
      throw new Error('Pricing not found');
    }

    await ctx.db.delete(args.id);
    await ctx.scheduler.runAfter(0, internal.pricingSync.deleteFromKV, {
      provider: pricing.provider,
      model: pricing.model,
    });
  },
});

export const syncAllToKV = action({
  args: {},
  handler: async (ctx) => {
    await requireAdminAction(ctx);

    const allPricing = await ctx.runQuery(internal.modelPricing.listAll);
    let synced = 0;

    for (const pricing of allPricing) {
      await ctx.runAction(internal.pricingSync.syncToKV, {
        provider: pricing.provider,
        model: pricing.model,
      });
      synced++;
    }

    return { synced };
  },
});

export const listAll = internalQuery({
  handler: async (ctx) => {
    return ctx.db.query('modelPricing').collect();
  },
});

interface OpenRouterModel {
  id: string;
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
    internal_reasoning?: string;
  };
}

interface _OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

function convertOpenRouterModel(orModel: OpenRouterModel): {
  provider: string;
  model: string;
  promptCostPerMillion: number;
  completionCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  reasoningCostPerMillion?: number;
} | null {
  const [provider, ...modelParts] = orModel.id.split('/');
  const modelName = modelParts.join('/');

  if (!provider || !modelName) return null;

  // Convert from per-token to per-million (microdollars)
  // OpenRouter returns prices as strings like "0.000003" (dollars per token)
  // We need microdollars per million: price * 1_000_000 * 1_000_000
  const promptCostPerMillion = Math.round(parseFloat(orModel.pricing.prompt) * 1_000_000_000_000);
  const completionCostPerMillion = Math.round(
    parseFloat(orModel.pricing.completion) * 1_000_000_000_000,
  );

  const cacheReadCostPerMillion = orModel.pricing.input_cache_read
    ? Math.round(parseFloat(orModel.pricing.input_cache_read) * 1_000_000_000_000)
    : undefined;
  const cacheWriteCostPerMillion = orModel.pricing.input_cache_write
    ? Math.round(parseFloat(orModel.pricing.input_cache_write) * 1_000_000_000_000)
    : undefined;
  const reasoningCostPerMillion = orModel.pricing.internal_reasoning
    ? Math.round(parseFloat(orModel.pricing.internal_reasoning) * 1_000_000_000_000)
    : undefined;

  return {
    provider,
    model: orModel.id,
    promptCostPerMillion,
    completionCostPerMillion,
    cacheReadCostPerMillion,
    cacheWriteCostPerMillion,
    reasoningCostPerMillion,
  };
}

export const importFromOpenRouter = action({
  args: {},
  handler: async (ctx) => {
    await requireAdminAction(ctx);

    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json();
    let imported = 0;

    for (const orModel of data.data) {
      const converted = convertOpenRouterModel(orModel);
      if (!converted) continue;

      await ctx.runMutation(internal.modelPricing.upsertInternal, {
        provider: 'openrouter',
        model: converted.model,
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

export const syncDefaults = action({
  args: {},
  handler: async (ctx) => {
    await requireAdminAction(ctx);

    let synced = 0;
    for (const pricing of DEFAULT_PRICING) {
      await ctx.runMutation(internal.modelPricing.upsertInternal, {
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
    const allPricing = await ctx.runQuery(internal.modelPricing.listAll);
    for (const p of allPricing) {
      await ctx.runAction(internal.pricingSync.syncToKV, {
        provider: p.provider,
        model: p.model,
      });
    }

    return { synced };
  },
});
