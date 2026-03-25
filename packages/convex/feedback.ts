import { RateLimiter, HOUR } from '@convex-dev/rate-limiter';
import { components } from './_generated/api';
import { mutation } from './_generated/server';
import { ConvexError, v } from 'convex/values';
import { requireEnabledUser } from './auth/userHelpers';

const rateLimiter = new RateLimiter(components.rateLimiter, {
  submitFeedback: { kind: 'fixed window', rate: 5, period: HOUR },
});

export const MAX_MESSAGE_LENGTH = 3000;

export const submit = mutation({
  args: {
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);

    await rateLimiter.limit(ctx, 'submitFeedback', {
      key: user._id,
      throws: true,
    });

    const trimmed = args.message.trim();
    if (trimmed.length === 0) {
      throw new ConvexError('Feedback message cannot be empty');
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new ConvexError(`Feedback message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);
    }

    await ctx.db.insert('feedback', {
      userId: user._id,
      message: trimmed,
    });
  },
});
