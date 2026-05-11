import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { requireAdmin } from './auth/users';
import { rateLimiter } from './rateLimits';

export const joinWaitlist = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ status: v.literal('already_on_waitlist'), confirmed: v.boolean() }),
    v.object({ status: v.literal('joined'), id: v.id('waitlist') }),
  ),
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim();

    await rateLimiter.limit(ctx, 'joinWaitlistEmail', { key: email, throws: true });

    const existing = await ctx.db
      .query('waitlist')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first();

    if (existing) {
      return { status: 'already_on_waitlist' as const, confirmed: existing.confirmed };
    }

    const confirmationToken = crypto.randomUUID();

    const id = await ctx.db.insert('waitlist', {
      email,
      source: args.source,
      confirmed: false,
      confirmationToken,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.emails.sendConfirmationEmail, {
      email,
      confirmationToken,
    });

    return { status: 'joined' as const, id };
  },
});

export const confirmEmail = mutation({
  args: { token: v.string() },
  returns: v.object({ alreadyConfirmed: v.boolean() }),
  handler: async (ctx, args) => {
    await rateLimiter.limit(ctx, 'confirmEmail', { key: args.token, throws: true });

    const entry = await ctx.db
      .query('waitlist')
      .withIndex('by_confirmation_token', (q) => q.eq('confirmationToken', args.token))
      .first();

    if (!entry) {
      throw new Error('Invalid confirmation link');
    }

    if (entry.confirmed) {
      return { alreadyConfirmed: true };
    }

    await ctx.db.patch(entry._id, { confirmed: true });
    return { alreadyConfirmed: false };
  },
});

export const listWaitlist = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('waitlist'),
      _creationTime: v.number(),
      email: v.string(),
      source: v.optional(v.string()),
      confirmed: v.boolean(),
      confirmationToken: v.string(),
      notifiedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query('waitlist').order('desc').collect();
  },
});

export const bulkInviteFromWaitlist = mutation({
  args: { waitlistIds: v.array(v.id('waitlist')) },
  returns: v.object({ invited: v.number() }),
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    let invited = 0;

    for (const waitlistId of args.waitlistIds) {
      const entry = await ctx.db.get(waitlistId);
      if (!entry?.confirmed) continue;

      const existingInvite = await ctx.db
        .query('invites')
        .withIndex('by_email', (q) => q.eq('email', entry.email))
        .filter((q) => q.eq(q.field('status'), 'pending'))
        .first();

      if (existingInvite) continue;

      const token = crypto.randomUUID();
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

      await ctx.db.insert('invites', {
        email: entry.email,
        invitedBy: admin._id,
        status: 'pending',
        token,
        expiresAt,
      });

      await ctx.scheduler.runAfter(0, internal.integrations.emails.sendInviteEmail, {
        email: entry.email,
        token,
      });

      await ctx.db.patch(waitlistId, { notifiedAt: Date.now() });
      invited++;
    }

    return { invited };
  },
});
