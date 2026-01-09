import { internalMutation, internalQuery } from '../_generated/server';
import { v } from 'convex/values';

export const registerClient = internalMutation({
  args: {
    clientId: v.string(),
    redirectUris: v.array(v.string()),
    clientName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('mcpClients', {
      clientId: args.clientId,
      redirectUris: args.redirectUris,
      clientName: args.clientName,
    });
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
