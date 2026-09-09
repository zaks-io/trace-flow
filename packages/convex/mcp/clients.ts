import { internalMutation, internalQuery } from '../_generated/server';
import { v } from 'convex/values';
import { rateLimiter } from '../rateLimits';

export const registerClient = internalMutation({
  args: {
    clientId: v.string(),
    redirectUris: v.array(v.string()),
    clientName: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), retryAfter: v.number() }),
  ),
  handler: async (ctx, args) => {
    const limit = await rateLimiter.limit(ctx, 'mcpRegisterClient');
    if (!limit.ok) return limit;

    await ctx.db.insert('mcpClients', {
      clientId: args.clientId,
      redirectUris: args.redirectUris,
      clientName: args.clientName,
    });
    return { ok: true as const };
  },
});

export const getClient = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query('mcpClients')
      .withIndex('by_client_id', (q) => q.eq('clientId', args.clientId))
      .first();
  },
});
