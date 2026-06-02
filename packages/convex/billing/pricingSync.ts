import { internalAction } from '../_generated/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';

interface PricingKvConfig {
  apiToken: string;
  namespaceUrl: string;
}

interface PricingKvRequest {
  method: 'PUT' | 'DELETE';
  body?: string;
  failureLabel: string;
  allowNotFound?: boolean;
}

function getPricingKvConfig(): PricingKvConfig {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const namespaceId = process.env.CLOUDFLARE_PRICING_KV_NAMESPACE_ID;

  if (!accountId || !apiToken || !namespaceId) {
    throw new Error('Cloudflare pricing KV environment variables not set');
  }

  return {
    apiToken,
    namespaceUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`,
  };
}

function pricingKvKey(provider: string, model: string): string {
  return `pricing:${provider}:${model}`;
}

async function requestPricingKv(
  provider: string,
  model: string,
  request: PricingKvRequest,
): Promise<void> {
  const { apiToken, namespaceUrl } = getPricingKvConfig();
  const url = `${namespaceUrl}/${encodeURIComponent(pricingKvKey(provider, model))}`;
  const response = await fetch(url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(request.body ? { 'Content-Type': 'text/plain' } : {}),
    },
    body: request.body,
  });

  if (!response.ok && !(request.allowNotFound && response.status === 404)) {
    const errorText = await response.text();
    throw new Error(`Failed to ${request.failureLabel}: ${response.status} - ${errorText}`);
  }
}

export const syncToKV = internalAction({
  args: {
    provider: v.string(),
    model: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pricing = await ctx.runQuery(internal.billing.modelPricing.getInternal, {
      provider: args.provider,
      model: args.model,
    });

    if (!pricing) return null;

    const value = JSON.stringify({
      promptCostPerMillion: pricing.promptCostPerMillion,
      completionCostPerMillion: pricing.completionCostPerMillion,
      cacheReadCostPerMillion: pricing.cacheReadCostPerMillion,
      cacheWriteCostPerMillion: pricing.cacheWriteCostPerMillion,
      cacheWrite1hCostPerMillion: pricing.cacheWrite1hCostPerMillion,
      reasoningCostPerMillion: pricing.reasoningCostPerMillion,
      // The consumer's `@trace-flow/pricing` reads `contextTier` to swap in tier rates above the
      // threshold; dropping it here would silently undercount gpt-5.5 / large-context messages.
      contextTier: pricing.contextTier,
      updatedAt: pricing.updatedAt,
      source: pricing.source,
    });

    await requestPricingKv(args.provider, args.model, {
      method: 'PUT',
      body: value,
      failureLabel: 'sync pricing to KV',
    });

    return null;
  },
});

export const deleteFromKV = internalAction({
  args: {
    provider: v.string(),
    model: v.string(),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    await requestPricingKv(args.provider, args.model, {
      method: 'DELETE',
      failureLabel: 'delete pricing from KV',
      allowNotFound: true,
    });

    return null;
  },
});
