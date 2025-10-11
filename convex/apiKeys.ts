import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { requireObserveRole } from './auth';
import { internal } from './_generated/api';

export const list = query({
  handler: async (ctx) => {
    await requireObserveRole(ctx);
    return await ctx.db.query('apiKeys').collect();
  },
});

export const getByKey = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    await requireObserveRole(ctx);
    return await ctx.db
      .query('apiKeys')
      .filter((q) => q.eq(q.field('key'), args.key))
      .first();
  },
});

export const create = mutation({
  args: {
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireObserveRole(ctx);
    const key = crypto.randomUUID();

    const id = await ctx.db.insert('apiKeys', {
      key,
      expiresAt: args.expiresAt,
    });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncKeyToKV, {
      key,
      expiresAt: args.expiresAt,
    });

    return id;
  },
});

export const remove = mutation({
  args: { id: v.id('apiKeys') },
  handler: async (ctx, args) => {
    await requireObserveRole(ctx);

    const apiKey = await ctx.db.get(args.id);
    if (!apiKey) {
      throw new Error('API key not found');
    }

    await ctx.db.delete(args.id);

    await ctx.scheduler.runAfter(0, internal.cloudflare.deleteKeyFromKV, {
      key: apiKey.key,
    });
  },
});
