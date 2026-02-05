import type { SubscriptionKVData, SubscriptionTier } from '@trace-flow/types';

interface UsageEnv {
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
}

export type UsageCheckResult =
  | { status: 'allowed'; tier: SubscriptionTier }
  | { status: 'exceeded'; tier: SubscriptionTier }
  | { status: 'no_subscription' };

export async function checkUsage(
  env: UsageEnv,
  orgId: string,
  count: number,
): Promise<UsageCheckResult> {
  const subConfigRaw = await env.API_KEYS.get(`sub:${orgId}`);
  if (!subConfigRaw) return { status: 'no_subscription' };

  const subscriptionConfig = JSON.parse(subConfigRaw) as SubscriptionKVData;
  const doId = env.USAGE_TRACKER.idFromName(orgId);
  const stub = env.USAGE_TRACKER.get(doId);
  const doResponse = await stub.fetch(
    new Request('http://do/check', {
      method: 'POST',
      body: JSON.stringify({ count, subscriptionConfig }),
    }),
  );
  const result: { allowed: boolean } = await doResponse.json();
  return result.allowed
    ? { status: 'allowed', tier: subscriptionConfig.tier }
    : { status: 'exceeded', tier: subscriptionConfig.tier };
}
