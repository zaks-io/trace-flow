import type { SubscriptionKVData, SubscriptionTier } from '@trace-flow/types';
import { getCached } from './cache';

interface UsageEnv {
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
}

export type UsageCheckResult =
  | { status: 'allowed'; tier: SubscriptionTier }
  | { status: 'exceeded'; tier: SubscriptionTier; periodEnd: number }
  | { status: 'error'; reason: string };

export async function checkUsage(
  env: UsageEnv,
  orgId: string,
  count: number,
  prefetchedSubscription?: SubscriptionKVData,
): Promise<UsageCheckResult> {
  // Check cache for exceeded state before hitting the DO.
  // "allowed" is NEVER cached — the DO call both checks AND increments the counter.
  const cached = usageCache.get(orgId);
  if (cached && cached.expiry > Date.now()) {
    return cached.result;
  }
  usageCache.delete(orgId);

  let subscriptionConfig: SubscriptionKVData;

  if (prefetchedSubscription) {
    subscriptionConfig = prefetchedSubscription;
  } else {
    const subConfigRaw = await getCached(`sub:${orgId}`, () => env.API_KEYS.get(`sub:${orgId}`));
    if (!subConfigRaw) {
      return { status: 'error', reason: 'no_subscription_config' };
    }

    try {
      subscriptionConfig = JSON.parse(subConfigRaw) as SubscriptionKVData;
    } catch {
      return { status: 'error', reason: 'invalid_subscription_config' };
    }
  }

  let result: { allowed: boolean; periodEnd?: number };
  try {
    const doId = env.USAGE_TRACKER.idFromName(orgId);
    const stub = env.USAGE_TRACKER.get(doId);
    const doResponse = await stub.fetch(
      new Request('http://do/check', {
        method: 'POST',
        body: JSON.stringify({ count, subscriptionConfig, orgId }),
      }),
    );
    result = await doResponse.json();
  } catch {
    return { status: 'error', reason: 'do_unreachable' };
  }

  if (result.allowed) {
    return { status: 'allowed', tier: subscriptionConfig.tier };
  }

  if (result.periodEnd === undefined) {
    console.error('DO returned exceeded without periodEnd', { orgId });
    return { status: 'error', reason: 'do_missing_period_end' };
  }

  const exceeded: UsageCheckResult = {
    status: 'exceeded',
    tier: subscriptionConfig.tier,
    periodEnd: result.periodEnd,
  };

  // Cache exceeded result to avoid DO calls for every subsequent request
  cacheUsageResult(orgId, exceeded);

  return exceeded;
}

const USAGE_CACHE_TTL_MS = 60_000;
const MAX_USAGE_CACHE_ENTRIES = 1_000;

// Module-scope cache for exceeded state only.
// Not using the two-layer cache here because DO results contain org-specific
// state that doesn't benefit from Cache API (already scoped to this colo's DO).
const usageCache = new Map<string, { result: UsageCheckResult; expiry: number }>();

function cacheUsageResult(orgId: string, result: UsageCheckResult): void {
  // Only cache "exceeded" — the one truly terminal state within a billing period.
  // "allowed" must never be cached (DO call increments the counter).
  // "error" must never be cached (transient — DO cold start, network blip).
  if (result.status !== 'exceeded') return;

  // Cap size: evict expired first, then FIFO oldest entries
  if (usageCache.size >= MAX_USAGE_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of usageCache) {
      if (v.expiry <= now) usageCache.delete(k);
    }
    if (usageCache.size >= MAX_USAGE_CACHE_ENTRIES) {
      const first = usageCache.keys().next();
      if (!first.done) usageCache.delete(first.value);
    }
  }

  const now = Date.now();
  const ttl = Math.max(0, Math.min(USAGE_CACHE_TTL_MS, result.periodEnd - now));
  if (ttl === 0) return;
  usageCache.set(orgId, { result, expiry: now + ttl });
}

/** Visible for testing */
export function _clearUsageCache(orgId?: string): void {
  if (orgId) {
    usageCache.delete(orgId);
  } else {
    usageCache.clear();
  }
}
