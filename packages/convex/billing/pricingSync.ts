import { internalAction } from '../_generated/server';
import { OPENROUTER_PRICING_TTL_SECONDS, serializeModelPricing } from '@trace-flow/pricing';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { cloudflareKvValuesUrl } from '../integrations/cloudflareApi';

interface PricingKvConfig {
  apiToken: string;
  namespaceUrl: string;
}

interface PricingKvRequest {
  method: 'PUT' | 'DELETE';
  body?: string;
  failureLabel: string;
  allowNotFound?: boolean;
  expirationTtl?: number;
}

class RetryablePricingKvError extends Error {}

const PRICING_SYNC_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function getPricingKvConfig(): PricingKvConfig {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const namespaceId = process.env.CLOUDFLARE_PRICING_KV_NAMESPACE_ID;

  if (!accountId || !apiToken || !namespaceId) {
    throw new Error('Cloudflare pricing KV environment variables not set');
  }

  return {
    apiToken,
    namespaceUrl: cloudflareKvValuesUrl(accountId, namespaceId),
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
  const url = new URL(`${namespaceUrl}/${encodeURIComponent(pricingKvKey(provider, model))}`);
  if (request.expirationTtl !== undefined) {
    url.searchParams.set('expiration_ttl', String(request.expirationTtl));
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(request.body ? { 'Content-Type': 'text/plain' } : {}),
      },
      body: request.body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    ) {
      throw new RetryablePricingKvError('Cloudflare pricing KV request did not complete');
    }
    throw error;
  }

  if (!response.ok && !(request.allowNotFound && response.status === 404)) {
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new RetryablePricingKvError(`Cloudflare pricing KV returned HTTP ${response.status}`);
    }
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
    for (let attempt = 0; ; attempt++) {
      const pricing = await ctx.runQuery(internal.billing.modelPricing.getInternal, {
        provider: args.provider,
        model: args.model,
      });

      if (!pricing) return null;

      const value = serializeModelPricing({
        promptCostPerMillion: pricing.promptCostPerMillion,
        completionCostPerMillion: pricing.completionCostPerMillion,
        cacheReadCostPerMillion: pricing.cacheReadCostPerMillion,
        cacheWriteCostPerMillion: pricing.cacheWriteCostPerMillion,
        cacheWrite1hCostPerMillion: pricing.cacheWrite1hCostPerMillion,
        reasoningCostPerMillion: pricing.reasoningCostPerMillion,
        // The consumer's `@trace-flow/pricing` reads `contextTier` to swap in tier rates above the
        // threshold; dropping it here would silently undercount gpt-5.5 / large-context messages.
        contextTier: pricing.contextTier,
        serviceTiers: pricing.serviceTiers,
        updatedAt: pricing.updatedAt,
        source: pricing.source,
      });

      try {
        await requestPricingKv(args.provider, args.model, {
          method: 'PUT',
          body: value,
          failureLabel: 'sync pricing to KV',
          expirationTtl:
            pricing.source === 'openrouter' ? OPENROUTER_PRICING_TTL_SECONDS : undefined,
        });
      } catch (error) {
        const delayMs = PRICING_SYNC_RETRY_DELAYS_MS[attempt];
        if (!(error instanceof RetryablePricingKvError) || delayMs === undefined) throw error;
        // Convex does not retry scheduled actions. Bound retries and re-read current pricing each time.
        console.warn('convex.pricing_kv_sync_retry', {
          attempt: attempt + 1,
          delayMs,
          reason: error.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return null;
    }
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
