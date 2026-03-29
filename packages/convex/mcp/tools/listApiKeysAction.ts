import { internalAction } from '../../_generated/server';
import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import type { ToolCallResult } from '../protocol';

export const listApiKeys = internalAction({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args): Promise<ToolCallResult> => {
    const apiKeys = await ctx.runQuery(internal.apiKeys.listForUser, {
      userId: args.userId,
    });

    const now = Date.now();
    const keys = apiKeys
      .filter((k) => k.expiresAt > now)
      .map((k) => ({
        id: k._id,
        name: k.name ?? 'Unnamed key',
        expires_at: new Date(k.expiresAt).toISOString(),
      }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ api_keys: keys, total: keys.length }),
        },
      ],
    };
  },
});
