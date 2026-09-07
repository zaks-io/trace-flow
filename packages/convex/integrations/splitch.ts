import { Splitch, type ResolutionDetails } from '@splitch/convex';
import { v } from 'convex/values';
import { components } from '../_generated/api';
import { internalAction, internalQuery, query } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
import { getCurrentUser } from '../auth/userHelpers';

const flags = new Splitch(components.splitch);

export const PRO_SUBSCRIPTION_FLAG = 'pro-subscription-enabled';

interface ProSubscriptionIdentity {
  tokenIdentifier: string;
  email?: string;
  name?: string;
  tier?: 'hobby' | 'pro';
}

function reportResolutionFailure(details: ResolutionDetails): void {
  console.error('convex.splitch_flag_resolution_failed', {
    flagKey: PRO_SUBSCRIPTION_FLAG,
    reason: details.reason,
    errorCode: details.errorCode,
    errorMessage: details.errorMessage,
  });
}

async function resolveProSubscriptionEnabled(
  ctx: QueryCtx,
  identity: ProSubscriptionIdentity,
): Promise<boolean> {
  try {
    const attributes: Record<string, string> = {};
    if (identity.email) attributes.email = identity.email;
    if (identity.name) attributes.name = identity.name;
    if (identity.tier) attributes.tier = identity.tier;

    const details = await flags.peekDetails(
      ctx,
      PRO_SUBSCRIPTION_FLAG,
      {
        targetingKey: identity.tokenIdentifier,
        attributes,
      },
      false,
    );

    if (details.reason === 'ERROR' || details.reason === 'STALE') {
      reportResolutionFailure(details);
      return false;
    }
    if (typeof details.value !== 'boolean') {
      console.error('convex.splitch_flag_type_invalid', {
        flagKey: PRO_SUBSCRIPTION_FLAG,
        valueType: typeof details.value,
      });
      return false;
    }
    return details.value;
  } catch (error) {
    console.error('convex.splitch_flag_resolution_threw', {
      flagKey: PRO_SUBSCRIPTION_FLAG,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export const proSubscriptionEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Authentication required');

    const user = await getCurrentUser(ctx);
    const subscription = user?.orgId
      ? await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
          .first()
      : null;

    return resolveProSubscriptionEnabled(ctx, {
      tokenIdentifier: identity.tokenIdentifier,
      email: user?.email ?? identity.email,
      name: user?.name ?? identity.name,
      tier: subscription?.tier,
    });
  },
});

export const proSubscriptionEnabledInternal = internalQuery({
  args: {
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    tier: v.optional(v.union(v.literal('hobby'), v.literal('pro'))),
  },
  returns: v.boolean(),
  handler: (ctx, args) => resolveProSubscriptionEnabled(ctx, args),
});

export const install = internalAction({
  args: {},
  returns: v.object({
    appId: v.string(),
    environmentId: v.string(),
    environmentVersion: v.number(),
    installationId: v.string(),
    status: v.union(v.literal('active'), v.literal('revoked')),
  }),
  handler: (ctx) => flags.install(ctx),
});
