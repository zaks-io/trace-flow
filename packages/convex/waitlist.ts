import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { requireAdmin } from './users';

export const joinWaitlist = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.toLowerCase().trim();

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

    await ctx.scheduler.runAfter(0, internal.emails.sendConfirmationEmail, {
      email,
      confirmationToken,
    });

    return { status: 'joined' as const, id };
  },
});

export const confirmEmail = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
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
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query('waitlist').order('desc').collect();
  },
});

export const bulkInviteFromWaitlist = mutation({
  args: { waitlistIds: v.array(v.id('waitlist')) },
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

      await ctx.scheduler.runAfter(0, internal.emails.sendInviteEmail, {
        email: entry.email,
        token,
      });

      await ctx.db.patch(waitlistId, { notifiedAt: Date.now() });
      invited++;
    }

    return { invited };
  },
});
