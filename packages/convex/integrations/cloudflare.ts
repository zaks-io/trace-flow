import { internalAction, internalQuery, action } from '../_generated/server';
import { v } from 'convex/values';
import { axiomConfigFromEnv, createConvexLogger } from '@trace-flow/logging';
import { internal } from '../_generated/api';
import { requireAuthenticated } from '../auth/auth';
import { extractSub } from '../auth/users';
import {
  apiKeyValidator,
  collectorCredentialValidator,
  subscriptionValidator,
  userValidator,
} from '../validators';

interface KvConfig {
  accountId: string;
  apiToken: string;
  namespaceId: string;
}

function getCloudflareConfig(): KvConfig {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;

  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID environment variable is not set');
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN environment variable is not set');
  if (!namespaceId) throw new Error('CLOUDFLARE_KV_NAMESPACE_ID environment variable is not set');

  return { accountId, apiToken, namespaceId };
}

// Collector Credentials live in their own KV namespace, separate from the
// API-key store, so a hidden desktop credential never collides with or leaks
// into the user-facing API-key path.
function getCollectorCredsConfig(): KvConfig {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const namespaceId = process.env.CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID;

  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID environment variable is not set');
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN environment variable is not set');
  if (!namespaceId)
    throw new Error('CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID environment variable is not set');

  return { accountId, apiToken, namespaceId };
}

function kvValueUrl({ accountId, namespaceId }: KvConfig, key: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
}

async function kvPut(config: KvConfig, key: string, value: string) {
  const response = await fetch(kvValueUrl(config, key), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
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

async function kvDelete(config: KvConfig, key: string) {
  const response = await fetch(kvValueUrl(config, key), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });

  // 404 means the key is already gone — the desired end state, not a failure.
  if (!response.ok && response.status !== 404) {
    const errorText = await response.text();
    throw new Error(
      `Failed to delete KV key ${key}: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }
}

async function putKV(key: string, value: string) {
  await kvPut(getCloudflareConfig(), key, value);
}

// KV key for a Collector Credential. The Worker hashes the header secret with
// SHA-256 and looks up `collector:<hash>`; the plaintext secret is never stored.
function collectorKvKey(hashedSecret: string): string {
  return `collector:${hashedSecret}`;
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

export const syncCollectorCredToKV = internalAction({
  args: {
    hashedSecret: v.string(),
    orgId: v.string(),
    userId: v.string(),
    collectorId: v.string(),
    expiresAt: v.number(),
    status: v.union(v.literal('active'), v.literal('revoked')),
    createdAt: v.number(),
    retryCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const value = JSON.stringify({
      orgId: args.orgId,
      userId: args.userId,
      collectorId: args.collectorId,
      expiresAt: args.expiresAt,
      status: args.status,
      createdAt: args.createdAt,
    });

    try {
      await kvPut(getCollectorCredsConfig(), collectorKvKey(args.hashedSecret), value);
    } catch (e) {
      const attempt = args.retryCount ?? 0;
      console.error('convex.cloudflare_sync_collector_cred_failed', { attempt, error: e });
      if (attempt < 3) {
        await ctx.scheduler.runAfter(
          30_000,
          internal.integrations.cloudflare.syncCollectorCredToKV,
          {
            ...args,
            retryCount: attempt + 1,
          },
        );
        return;
      }
      throw e;
    }
  },
});

export const deleteCollectorCredFromKV = internalAction({
  args: { hashedSecret: v.string(), retryCount: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await kvDelete(getCollectorCredsConfig(), collectorKvKey(args.hashedSecret));
    } catch (e) {
      const attempt = args.retryCount ?? 0;
      console.error('convex.cloudflare_delete_collector_cred_failed', { attempt, error: e });
      if (attempt < 3) {
        await ctx.scheduler.runAfter(
          30_000,
          internal.integrations.cloudflare.deleteCollectorCredFromKV,
          { ...args, retryCount: attempt + 1 },
        );
        return;
      }
      throw e;
    }
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
    const logger = createConvexLogger({
      service: 'convex',
      convexFunction: 'cloudflare.syncSubscriptionToKV',
      axiom: axiomConfigFromEnv({
        AXIOM_TOKEN: process.env.AXIOM_TOKEN,
        AXIOM_DATASET: process.env.AXIOM_DATASET,
        AXIOM_DOMAIN: process.env.AXIOM_DOMAIN,
      }),
      context: {
        component: 'cloudflare-sync',
        orgId: args.orgId,
      },
    });
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
      logger.info('convex.cloudflare_sync_subscription_success', {
        tier: args.tier,
      });
    } catch (e) {
      const attempt = args.retryCount ?? 0;
      logger.error('convex.cloudflare_sync_subscription_failed', e, {
        attempt,
      });
      if (attempt < 3) {
        await ctx.scheduler.runAfter(
          30_000,
          internal.integrations.cloudflare.syncSubscriptionToKV,
          {
            ...args,
            retryCount: attempt + 1,
          },
        );
      } else {
        throw e;
      }
    } finally {
      await logger.flush();
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
        await ctx.scheduler.runAfter(30_000, internal.integrations.cloudflare.syncUserOrgToKV, {
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
        await ctx.scheduler.runAfter(30_000, internal.integrations.cloudflare.deleteUserOrgFromKV, {
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
    apiKeys: v.array(apiKeyValidator),
    subscriptions: v.array(subscriptionValidator),
    users: v.array(userValidator),
    collectorCredentials: v.array(collectorCredentialValidator),
  }),
  handler: async (ctx) => {
    const apiKeys = await ctx.db.query('apiKeys').collect();
    const subscriptions = await ctx.db.query('subscriptions').collect();
    const users = await ctx.db.query('users').collect();
    const collectorCredentials = await ctx.db.query('collectorCredentials').collect();
    return { apiKeys, subscriptions, users, collectorCredentials };
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
    collectorCredSynced: v.number(),
  }),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const isAdmin = await ctx.runQuery(internal.integrations.cloudflare.isCallerAdmin);
    if (!isAdmin) throw new Error('Admin access required');
    const { apiKeys, subscriptions, users, collectorCredentials } = await ctx.runQuery(
      internal.integrations.cloudflare.getAllSyncData,
    );

    await runBatched(apiKeys, 10, (key) =>
      ctx.runAction(internal.integrations.cloudflare.syncKeyToKV, {
        key: key.key,
        expiresAt: key.expiresAt,
        orgId: key.orgId,
      }),
    );

    await runBatched(subscriptions, 10, (sub) =>
      ctx.runAction(internal.integrations.cloudflare.syncSubscriptionToKV, {
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
      return ctx.runAction(internal.integrations.cloudflare.syncUserOrgToKV, {
        sub,
        orgId: user.orgId,
      });
    });

    // Only active credentials belong in KV; revoked ones must stay un-synced so
    // their secret hash can never re-authenticate.
    const activeCreds = collectorCredentials.filter((c) => c.status === 'active');
    await runBatched(activeCreds, 10, (cred) =>
      ctx.runAction(internal.integrations.cloudflare.syncCollectorCredToKV, {
        hashedSecret: cred.hashedSecret,
        orgId: cred.orgId,
        userId: cred.userId,
        collectorId: cred.collectorId,
        expiresAt: cred.expiresAt,
        status: cred.status,
        createdAt: cred._creationTime,
      }),
    );

    return {
      keySynced: apiKeys.length,
      subSynced: subscriptions.length,
      userOrgSynced: usersWithOrg.length,
      collectorCredSynced: activeCreds.length,
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
