import { internalAction, internalQuery, action } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { requireTraceFlowRole } from './auth';
import type { Doc } from './_generated/dataModel';
import { extractSub } from './users';

function getCloudflareConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;

  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID environment variable is not set');
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN environment variable is not set');
  if (!namespaceId) throw new Error('CLOUDFLARE_KV_NAMESPACE_ID environment variable is not set');

  return { accountId, apiToken, namespaceId };
}

async function putKV(key: string, value: string) {
  const { accountId, apiToken, namespaceId } = getCloudflareConfig();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;

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
    throw new Error(
      `Failed to write KV key ${key}: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }
}

export const syncKeyToKV = internalAction({
  args: {
    key: v.string(),
    expiresAt: v.number(),
    orgId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const value = JSON.stringify({
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
      orgId: args.orgId,
    });

    await putKV(args.key, value);
  },
});

export const syncSubscriptionToKV = internalAction({
  args: {
    orgId: v.string(),
    tier: v.string(),
    monthlyUnits: v.number(),
    addonUnits: v.number(),
    status: v.string(),
    currentPeriodStart: v.number(),
    currentPeriodEnd: v.number(),
    autoOverage: v.optional(v.boolean()),
    overageCapCents: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    retryCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const value = JSON.stringify({
      tier: args.tier,
      monthlyUnits: args.monthlyUnits,
      addonUnits: args.addonUnits,
      status: args.status,
      currentPeriodStart: args.currentPeriodStart,
      currentPeriodEnd: args.currentPeriodEnd,
      autoOverage: args.autoOverage,
      overageCapCents: args.overageCapCents,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
    });

    try {
      await putKV(`sub:${args.orgId}`, value);
    } catch (e) {
      const attempt = args.retryCount ?? 0;
      console.error('syncSubscriptionToKV failed', {
        orgId: args.orgId,
        attempt,
        error: e instanceof Error ? e.message : String(e),
      });
      if (attempt < 3) {
        await ctx.scheduler.runAfter(30_000, internal.cloudflare.syncSubscriptionToKV, {
          ...args,
          retryCount: attempt + 1,
        });
        return;
      }
      throw e;
    }
  },
});

export const syncUserOrgToKV = internalAction({
  args: {
    sub: v.string(),
    orgId: v.string(),
    retryCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await putKV(`user-org:${args.sub}`, JSON.stringify({ orgId: args.orgId }));
    } catch (e) {
      const attempt = args.retryCount ?? 0;
      if (attempt < 3) {
        await ctx.scheduler.runAfter(30_000, internal.cloudflare.syncUserOrgToKV, {
          ...args,
          retryCount: attempt + 1,
        });
        return;
      }
      throw e;
    }
  },
});

export const deleteUserOrgFromKV = internalAction({
  args: {
    sub: v.string(),
    retryCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { accountId, apiToken, namespaceId } = getCloudflareConfig();
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/user-org:${encodeURIComponent(args.sub)}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!response.ok && response.status !== 404) {
      const attempt = args.retryCount ?? 0;
      if (attempt < 3) {
        await ctx.scheduler.runAfter(30_000, internal.cloudflare.deleteUserOrgFromKV, {
          sub: args.sub,
          retryCount: attempt + 1,
        });
        return;
      }
      const errorText = await response.text();
      throw new Error(
        `Failed to delete user-org KV: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
  },
});

export const checkKeyInKV = internalAction({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (_ctx, args): Promise<boolean> => {
    const { accountId, apiToken, namespaceId } = getCloudflareConfig();
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(args.key)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    return response.ok;
  },
});

export const isCallerAdmin = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const user = await ctx.db
      .query('users')
      .withIndex('by_token_identifier', (q) => q.eq('tokenIdentifier', identity.tokenIdentifier))
      .first();
    return user?.isAdmin === true;
  },
});

export const getAllSyncData = internalQuery({
  args: {},
  returns: v.object({
    apiKeys: v.array(
      v.object({
        _id: v.id('apiKeys'),
        _creationTime: v.number(),
        key: v.string(),
        expiresAt: v.number(),
        userId: v.optional(v.id('users')),
        orgId: v.optional(v.id('organizations')),
        name: v.optional(v.string()),
      }),
    ),
    subscriptions: v.array(
      v.object({
        _id: v.id('subscriptions'),
        _creationTime: v.number(),
        orgId: v.id('organizations'),
        tier: v.union(v.literal('hobby'), v.literal('pro')),
        status: v.union(
          v.literal('active'),
          v.literal('grace'),
          v.literal('suspended'),
          v.literal('canceled'),
        ),
        monthlyUnits: v.number(),
        addonUnits: v.number(),
        currentPeriodStart: v.number(),
        currentPeriodEnd: v.number(),
        currentPeriodOverageSpentCents: v.number(),
        addonPurchaseCount: v.number(),
        stripeCustomerId: v.optional(v.string()),
        stripeSubscriptionId: v.optional(v.string()),
        stripePlanItemId: v.optional(v.string()),
        cancelAtPeriodEnd: v.optional(v.boolean()),
        autoOverage: v.optional(v.boolean()),
        overageCapCents: v.optional(v.number()),
        gracePeriodSchedulerId: v.optional(v.id('_scheduled_functions')),
        autoTopupPendingSince: v.optional(v.number()),
      }),
    ),
    users: v.array(
      v.object({
        _id: v.id('users'),
        _creationTime: v.number(),
        tokenIdentifier: v.string(),
        email: v.string(),
        name: v.optional(v.string()),
        picture: v.optional(v.string()),
        enabled: v.boolean(),
        orgId: v.optional(v.id('organizations')),
        inviteId: v.optional(v.id('invites')),
        isAdmin: v.optional(v.boolean()),
      }),
    ),
  }),
  handler: async (ctx) => {
    const apiKeys = await ctx.db.query('apiKeys').collect();
    const subscriptions = await ctx.db.query('subscriptions').collect();
    const users = await ctx.db.query('users').collect();
    return { apiKeys, subscriptions, users };
  },
});

async function runBatched<T>(items: T[], concurrency: number, fn: (item: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

export const syncAll = action({
  args: {},
  returns: v.object({
    keySynced: v.number(),
    subSynced: v.number(),
    userOrgSynced: v.number(),
  }),
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const isAdmin = await ctx.runQuery(internal.cloudflare.isCallerAdmin);
    if (!isAdmin) throw new Error('Admin access required');
    const { apiKeys, subscriptions, users } = (await ctx.runQuery(
      internal.cloudflare.getAllSyncData,
    )) as {
      apiKeys: Doc<'apiKeys'>[];
      subscriptions: Doc<'subscriptions'>[];
      users: Doc<'users'>[];
    };

    await runBatched(apiKeys, 10, (key) =>
      ctx.runAction(internal.cloudflare.syncKeyToKV, {
        key: key.key,
        expiresAt: key.expiresAt,
        orgId: key.orgId,
      }),
    );

    await runBatched(subscriptions, 10, (sub) =>
      ctx.runAction(internal.cloudflare.syncSubscriptionToKV, {
        orgId: sub.orgId,
        tier: sub.tier,
        monthlyUnits: sub.monthlyUnits,
        addonUnits: sub.addonUnits,
        status: sub.status,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        autoOverage: sub.autoOverage,
        overageCapCents: sub.overageCapCents,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      }),
    );

    // Sync user→org mappings for API worker body retrieval auth
    const usersWithOrg = users.filter((u) => u.orgId && u.tokenIdentifier);
    await runBatched(usersWithOrg, 10, (user) => {
      const sub = extractSub(user.tokenIdentifier);
      if (!sub || !user.orgId) return Promise.resolve();
      return ctx.runAction(internal.cloudflare.syncUserOrgToKV, {
        sub,
        orgId: user.orgId,
      });
    });

    return {
      keySynced: apiKeys.length,
      subSynced: subscriptions.length,
      userOrgSynced: usersWithOrg.length,
    };
  },
});

export const deleteKeyFromKV = internalAction({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const { accountId, apiToken, namespaceId } = getCloudflareConfig();
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(args.key)}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to delete key from KV: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
  },
});
