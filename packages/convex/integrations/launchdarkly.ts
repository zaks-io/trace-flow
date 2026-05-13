import { LaunchDarkly } from '@convex-dev/launchdarkly';
import { components } from '../_generated/api';
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server';

const launchdarkly = new LaunchDarkly(components.launchdarkly);

export const PRO_SUBSCRIPTION_FLAG = 'pro-subscription-enabled';

export interface LDUserContext {
  tokenIdentifier: string;
  email?: string;
  name?: string;
}

// Fails closed: if the SDK key isn't configured or the flag store is empty,
// Pro stays hidden. This matches the desired default state until a tester is
// explicitly targeted in LaunchDarkly.
export async function isProSubscriptionEnabled(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  user: LDUserContext,
): Promise<boolean> {
  if (!process.env.LAUNCHDARKLY_SDK_KEY) return false;
  try {
    const ld = launchdarkly.sdk(ctx);
    return await ld.boolVariation(
      PRO_SUBSCRIPTION_FLAG,
      {
        kind: 'user',
        key: user.tokenIdentifier,
        ...(user.email ? { email: user.email } : {}),
        ...(user.name ? { name: user.name } : {}),
      },
      false,
    );
  } catch {
    return false;
  }
}
