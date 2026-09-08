import { action, mutation, query, internalQuery, type QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import { internal } from './_generated/api';
import { getCurrentEnabledUser, requireEnabledUser } from './auth/users';
import { requireEnabledActionUser } from './auth/actionUser';
import { apiKeyValidator } from './validators';
import { rateLimiter } from './rateLimits';
import { analyticsKeyId } from '@trace-flow/utils';
import type { Doc } from './_generated/dataModel';

export function canAccessApiKey(
  user: Pick<Doc<'users'>, '_id' | 'orgId'>,
  apiKey: Pick<Doc<'apiKeys'>, 'userId' | 'orgId'>,
): boolean {
  if (apiKey.orgId) return apiKey.orgId === user.orgId;
  return apiKey.userId === user._id;
}

export function canManageApiKey(
  user: Pick<Doc<'users'>, '_id' | 'orgId'>,
  apiKey: Pick<Doc<'apiKeys'>, 'userId' | 'orgId'>,
): boolean {
  if (apiKey.orgId && apiKey.orgId !== user.orgId) return false;
  if (apiKey.userId) return apiKey.userId === user._id;
  return Boolean(apiKey.orgId && apiKey.orgId === user.orgId);
}

async function listAccessibleKeys(ctx: QueryCtx) {
  const user = await getCurrentEnabledUser(ctx);
  if (!user) return [];

  if (user.orgId) {
    const [orgKeys, userKeys] = await Promise.all([
      ctx.db
        .query('apiKeys')
        .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId))
        .collect(),
      ctx.db
        .query('apiKeys')
        .withIndex('by_user_id', (q) => q.eq('userId', user._id))
        .collect(),
    ]);
    const seen = new Set(orgKeys.map((key) => key._id));
    return [
      ...orgKeys,
      ...userKeys.filter((key) => !seen.has(key._id) && canAccessApiKey(user, key)),
    ];
  }

  return ctx.db
    .query('apiKeys')
    .withIndex('by_user_id', (q) => q.eq('userId', user._id))
    .collect();
}

export const list = query({
  args: {},
  returns: v.array(apiKeyValidator),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    return listAccessibleKeys(ctx);
  },
});

export const listAnalytics = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('apiKeys'),
      name: v.optional(v.string()),
      identifier: v.string(),
    }),
  ),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const apiKeys = await listAccessibleKeys(ctx);
    return Promise.all(
      apiKeys.map(async (apiKey) => ({
        _id: apiKey._id,
        name: apiKey.name,
        identifier: await analyticsKeyId(apiKey.key),
      })),
    );
  },
});

export const getByKey = query({
  args: { key: v.string() },
  returns: v.union(v.null(), apiKeyValidator),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await getCurrentEnabledUser(ctx);
    if (!user) return null;
    const apiKey = await ctx.db
      .query('apiKeys')
      .filter((q) => q.eq(q.field('key'), args.key))
      .first();
    return apiKey && canAccessApiKey(user, apiKey) ? apiKey : null;
  },
});

export const create = mutation({
  args: {
    expiresAt: v.number(),
    name: v.optional(v.string()),
  },
  returns: v.id('apiKeys'),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);

    await rateLimiter.limit(ctx, 'createApiKey', { key: user._id, throws: true });

    const key = crypto.randomUUID();

    const id = await ctx.db.insert('apiKeys', {
      key,
      expiresAt: args.expiresAt,
      userId: user._id,
      orgId: user.orgId,
      name: args.name,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncKeyToKV, {
      key,
      expiresAt: args.expiresAt,
      orgId: user.orgId,
    });

    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id('apiKeys'),
    name: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);

    const apiKey = await ctx.db.get(args.id);
    if (!apiKey) {
      throw new Error('API key not found');
    }

    if (!canManageApiKey(user, apiKey)) {
      throw new Error('You do not have permission to edit this API key');
    }

    const patch: { name?: string; expiresAt?: number } = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.expiresAt !== undefined) patch.expiresAt = args.expiresAt;

    await ctx.db.patch(args.id, patch);

    if (args.expiresAt !== undefined) {
      await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncKeyToKV, {
        key: apiKey.key,
        expiresAt: args.expiresAt,
        orgId: apiKey.orgId,
      });
    }
  },
});

export const remove = mutation({
  args: { id: v.id('apiKeys') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);

    const apiKey = await ctx.db.get(args.id);
    if (!apiKey) {
      throw new Error('API key not found');
    }

    if (!canManageApiKey(user, apiKey)) {
      throw new Error('You do not have permission to delete this API key');
    }

    await ctx.db.delete(args.id);

    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.deleteKeyFromKV, {
      key: apiKey.key,
    });
  },
});

export const syncToKV = action({
  args: { id: v.id('apiKeys') },
  returns: v.object({ synced: v.boolean(), existed: v.boolean() }),
  handler: async (ctx, args): Promise<{ synced: boolean; existed: boolean }> => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledActionUser(ctx);

    const apiKey = await ctx.runQuery(internal.apiKeys.getByIdInternal, { id: args.id });
    if (!apiKey) {
      throw new Error('API key not found');
    }
    if (!canManageApiKey(user, apiKey)) {
      throw new Error('You do not have permission to sync this API key');
    }

    const existsInKV = await ctx.runAction(internal.integrations.cloudflare.checkKeyInKV, {
      key: apiKey.key,
    });

    if (existsInKV) {
      return { synced: false, existed: true };
    }

    await ctx.runAction(internal.integrations.cloudflare.syncKeyToKV, {
      key: apiKey.key,
      expiresAt: apiKey.expiresAt,
      orgId: apiKey.orgId,
    });

    return { synced: true, existed: false };
  },
});

export const getByIdInternal = internalQuery({
  args: { id: v.id('apiKeys') },
  returns: v.union(v.null(), apiKeyValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Internal query for MCP - resolves org membership and returns the correct keys
export const listForUser = internalQuery({
  args: { userId: v.id('users') },
  returns: v.array(apiKeyValidator),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user?.enabled) return [];

    if (user.orgId) {
      const orgKeys = await ctx.db
        .query('apiKeys')
        .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId))
        .collect();
      const userKeys = await ctx.db
        .query('apiKeys')
        .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
        .collect();
      // Include pre-org keys (orgId undefined) that the org index misses
      const seen = new Set(orgKeys.map((k) => k._id));
      return [...orgKeys, ...userKeys.filter((k) => !seen.has(k._id) && canAccessApiKey(user, k))];
    }

    const userKeys = await ctx.db
      .query('apiKeys')
      .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
      .collect();
    return userKeys.filter((key) => canAccessApiKey(user, key));
  },
});

// Internal query - bypasses Convex auth, uses userId directly
export const listByUserId = internalQuery({
  args: { userId: v.id('users') },
  returns: v.array(apiKeyValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('apiKeys')
      .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
      .collect();
  },
});

// Internal query to get all API keys for an organization
export const listByOrgId = internalQuery({
  args: { orgId: v.id('organizations') },
  returns: v.array(apiKeyValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('apiKeys')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .collect();
  },
});
