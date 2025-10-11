import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { requireObserveRole } from './auth';

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
    key: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireObserveRole(ctx);
    return await ctx.db.insert('apiKeys', {
      key: args.key,
      expiresAt: args.expiresAt,
    });
  },
});

export const remove = mutation({
  args: { id: v.id('apiKeys') },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
