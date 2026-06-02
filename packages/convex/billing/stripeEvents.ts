import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';

interface StripeEventReadCtx {
  db: QueryCtx['db'];
}

function getStripeEventByEventId(
  ctx: StripeEventReadCtx,
  eventId: string,
): Promise<Doc<'stripeEvents'> | null> {
  return ctx.db
    .query('stripeEvents')
    .withIndex('by_event_id', (q) => q.eq('eventId', eventId))
    .first();
}

export const getByEventId = internalQuery({
  args: { eventId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id('stripeEvents'),
      _creationTime: v.number(),
      eventId: v.string(),
      eventType: v.string(),
      stripeObjectId: v.optional(v.string()),
      status: v.union(v.literal('processing'), v.literal('processed'), v.literal('failed')),
      processingStartedAt: v.optional(v.number()),
      processedAt: v.optional(v.number()),
      error: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return getStripeEventByEventId(ctx, args.eventId);
  },
});

export const startProcessing = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    stripeObjectId: v.optional(v.string()),
  },
  returns: v.object({
    alreadyProcessed: v.boolean(),
    eventDocId: v.id('stripeEvents'),
  }),
  handler: async (ctx, args) => {
    const existing = await getStripeEventByEventId(ctx, args.eventId);
    if (existing) {
      if (existing.status === 'processed') {
        return { alreadyProcessed: true, eventDocId: existing._id };
      }
      // Allow reprocessing stuck events after 5 minutes
      if (existing.status === 'processing') {
        const staleAfterMs = 5 * 60 * 1000;
        const startedAt = existing.processingStartedAt ?? existing._creationTime;
        if (Date.now() - startedAt > staleAfterMs) {
          await ctx.db.patch(existing._id, {
            status: 'processing',
            processingStartedAt: Date.now(),
          });
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
      processingStartedAt: Date.now(),
    });
    return { alreadyProcessed: false, eventDocId: id };
  },
});

export const markProcessed = internalMutation({
  args: { eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await getStripeEventByEventId(ctx, args.eventId);
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await getStripeEventByEventId(ctx, args.eventId);
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      status: 'failed',
      processedAt: Date.now(),
      error: args.error,
    });
  },
});

export const cleanupOldEvents = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const status of ['processed', 'failed'] as const) {
      const old = await ctx.db
        .query('stripeEvents')
        .withIndex('by_status', (q) => q.eq('status', status))
        .filter((q) => q.lt(q.field('processedAt'), cutoff))
        .take(500);
      for (const event of old) {
        await ctx.db.delete(event._id);
        deleted++;
      }
    }

    return { deleted };
  },
});
