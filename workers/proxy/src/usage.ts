import type { SubscriptionKVData, SubscriptionTier } from '@trace-flow/types';

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
  let subscriptionConfig: SubscriptionKVData;

  if (prefetchedSubscription) {
    subscriptionConfig = prefetchedSubscription;
  } else {
    const subConfigRaw = await env.API_KEYS.get(`sub:${orgId}`);
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

  return {
    status: 'exceeded',
    tier: subscriptionConfig.tier,
    periodEnd: result.periodEnd,
  };
}
