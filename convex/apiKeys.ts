import { action, mutation, query, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from './auth';
import { api, internal } from './_generated/api';
import { getCurrentUser, requireEnabledUser } from './users';

export const list = query({
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);

    if (!user) {
      return [];
    }

    const userKeys = await ctx.db
      .query('apiKeys')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .collect();

    return userKeys;
  },
});

export const getByKey = query({
  args: { key: v.string() },
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
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    const user = await requireEnabledUser(ctx);
    const key = crypto.randomUUID();

    const id = await ctx.db.insert('apiKeys', {
      key,
      expiresAt: args.expiresAt,
      userId: user._id,
      name: args.name,
    });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncKeyToKV, {
      key,
      expiresAt: args.expiresAt,
    });

    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id('apiKeys'),
    name: v.optional(v.string()),
  },
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

    await ctx.scheduler.runAfter(0, internal.cloudflare.deleteKeyFromKV, {
      key: apiKey.key,
    });
  },
});

export const syncToKV = action({
  args: { id: v.id('apiKeys') },
  handler: async (ctx, args): Promise<{ synced: boolean; existed: boolean }> => {
    await requireTraceFlowRole(ctx);

    const apiKey = await ctx.runQuery(api.apiKeys.getByIdInternal, { id: args.id });
    if (!apiKey) {
      throw new Error('API key not found');
    }

    const existsInKV = await ctx.runAction(internal.cloudflare.checkKeyInKV, {
      key: apiKey.key,
    });

    if (existsInKV) {
      return { synced: false, existed: true };
    }

    await ctx.runAction(internal.cloudflare.syncKeyToKV, {
      key: apiKey.key,
      expiresAt: apiKey.expiresAt,
    });

    return { synced: true, existed: false };
  },
});

export const getByIdInternal = query({
  args: { id: v.id('apiKeys') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Internal query for MCP - bypasses Convex auth, uses userId directly
export const listByUserId = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('apiKeys')
      .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
      .collect();
  },
});
