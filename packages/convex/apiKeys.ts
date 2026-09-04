import { action, mutation, query, internalQuery, type QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import { internal } from './_generated/api';
import { getCurrentUser, requireEnabledUser } from './auth/users';
import { apiKeyValidator } from './validators';
import { rateLimiter } from './rateLimits';
import { analyticsKeyId } from '@trace-flow/utils';

async function listAccessibleKeys(ctx: QueryCtx) {
  const user = await getCurrentUser(ctx);
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
    return [...orgKeys, ...userKeys.filter((key) => !seen.has(key._id))];
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
    return await ctx.db
      .query('apiKeys')
      .filter((q) => q.eq(q.field('key'), args.key))
      .first();
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

    if (apiKey.userId && apiKey.userId !== user._id) {
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

    if (apiKey.userId && apiKey.userId !== user._id) {
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

    const apiKey = await ctx.runQuery(internal.apiKeys.getByIdInternal, { id: args.id });
    if (!apiKey) {
      throw new Error('API key not found');
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
    if (!user) return [];

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
      return [...orgKeys, ...userKeys.filter((k) => !seen.has(k._id))];
    }

    return await ctx.db
      .query('apiKeys')
      .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
      .collect();
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
