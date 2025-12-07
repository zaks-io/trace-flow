import { internalAction } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';

export const syncToKV = internalAction({
  args: {
    provider: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const pricing = await ctx.runQuery(internal.modelPricing.getInternal, {
      provider: args.provider,
      model: args.model,
    });

    if (!pricing) return;

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const namespaceId = process.env.CLOUDFLARE_PRICING_KV_NAMESPACE_ID;

    if (!accountId || !apiToken || !namespaceId) {
      throw new Error('Cloudflare pricing KV environment variables not set');
    }

    const key = `pricing:${args.provider}:${args.model}`;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;

    const value = JSON.stringify({
      promptCostPerMillion: pricing.promptCostPerMillion,
      completionCostPerMillion: pricing.completionCostPerMillion,
      cacheReadCostPerMillion: pricing.cacheReadCostPerMillion,
      cacheWriteCostPerMillion: pricing.cacheWriteCostPerMillion,
      reasoningCostPerMillion: pricing.reasoningCostPerMillion,
      updatedAt: pricing.updatedAt,
      source: pricing.source,
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: value,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to sync pricing to KV: ${response.status} - ${errorText}`);
    }
  },
});

export const deleteFromKV = internalAction({
  args: {
    provider: v.string(),
    model: v.string(),
  },
  handler: async (_ctx, args) => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const namespaceId = process.env.CLOUDFLARE_PRICING_KV_NAMESPACE_ID;

    if (!accountId || !apiToken || !namespaceId) {
      throw new Error('Cloudflare pricing KV environment variables not set');
    }

    const key = `pricing:${args.provider}:${args.model}`;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`Failed to delete pricing from KV: ${response.status} - ${errorText}`);
    }
  },
});
