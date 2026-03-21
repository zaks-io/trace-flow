import { action, mutation, query, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from './auth/auth';
import { internal } from './_generated/api';
import { getCurrentUser, requireEnabledUser } from './auth/users';
import { apiKeyValidator } from './validators';

export const list = query({
  args: {},
  returns: v.array(apiKeyValidator),
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);

    if (!user) return [];

    if (user.orgId) {
      return await ctx.db
        .query('apiKeys')
        .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId))
        .collect();
    }

    return await ctx.db
      .query('apiKeys')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .collect();
  },
});

export const getByKey = query({
  args: { key: v.string() },
  returns: v.union(v.null(), apiKeyValidator),
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
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
    await requireTraceFlowRole(ctx);
    const user = await requireEnabledUser(ctx);
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    const user = await requireEnabledUser(ctx);

    const apiKey = await ctx.db.get(args.id);
    if (!apiKey) {
      throw new Error('API key not found');
    }

    if (apiKey.userId && apiKey.userId !== user._id) {
      throw new Error('You do not have permission to edit this API key');
    }

    await ctx.db.patch(args.id, { name: args.name });
  },
});

export const remove = mutation({
  args: { id: v.id('apiKeys') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
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
    await requireTraceFlowRole(ctx);

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

// Internal query for MCP - bypasses Convex auth, uses userId directly
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
