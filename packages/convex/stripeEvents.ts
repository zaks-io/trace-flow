import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';

export const getByEventId = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('stripeEvents')
      .withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
      .first();
  },
});

export const startProcessing = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    stripeObjectId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('stripeEvents')
      .withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
      .first();
    if (existing) {
      if (existing.status === 'processed') {
        return { alreadyProcessed: true, eventDocId: existing._id };
      }
      // Allow reprocessing stuck events after 5 minutes
      if (existing.status === 'processing') {
        const staleAfterMs = 5 * 60 * 1000;
        if (Date.now() - existing._creationTime > staleAfterMs) {
          await ctx.db.patch(existing._id, { status: 'processing' });
          return { alreadyProcessed: false, eventDocId: existing._id };
        }
        return { alreadyProcessed: true, eventDocId: existing._id };
      }
      // Failed events can be retried
      return { alreadyProcessed: false, eventDocId: existing._id };
    }
    const id = await ctx.db.insert('stripeEvents', {
      eventId: args.eventId,
      eventType: args.eventType,
      stripeObjectId: args.stripeObjectId,
      status: 'processing',
    });
    return { alreadyProcessed: false, eventDocId: id };
  },
});

export const markProcessed = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('stripeEvents')
      .withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
      .first();
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      status: 'processed',
      processedAt: Date.now(),
      error: undefined,
    });
  },
});

export const markFailed = internalMutation({
  args: {
    eventId: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('stripeEvents')
      .withIndex('by_event_id', (q) => q.eq('eventId', args.eventId))
      .first();
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      status: 'failed',
      processedAt: Date.now(),
      error: args.error,
    });
  },
});
