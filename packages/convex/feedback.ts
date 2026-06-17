import { mutation } from './_generated/server';
import { ConvexError, v } from 'convex/values';
import { FEEDBACK_MAX_MESSAGE_LENGTH } from '@trace-flow/types';
import { requireEnabledUser } from './auth/userHelpers';
import { rateLimiter } from './rateLimits';

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
    if (trimmed.length > FEEDBACK_MAX_MESSAGE_LENGTH) {
      throw new ConvexError(
        `Feedback message cannot exceed ${FEEDBACK_MAX_MESSAGE_LENGTH} characters`,
      );
    }

    await ctx.db.insert('feedback', {
      userId: user._id,
      message: trimmed,
    });
  },
});
