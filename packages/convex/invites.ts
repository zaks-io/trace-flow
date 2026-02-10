import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { requireAdmin } from './users';

const INVITE_EXPIRY_DAYS = 7;

export const createInvite = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const email = args.email.toLowerCase().trim();

    const existing = await ctx.db
      .query('invites')
      .withIndex('by_email', (q) => q.eq('email', email))
      .filter((q) => q.eq(q.field('status'), 'pending'))
      .first();

    if (existing) {
      throw new Error('A pending invite already exists for this email');
    }

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

    const inviteId = await ctx.db.insert('invites', {
      email,
      invitedBy: admin._id,
      status: 'pending',
      token,
      expiresAt,
    });

    await ctx.scheduler.runAfter(0, internal.emails.sendInviteEmail, {
      email,
      token,
    });

    return inviteId;
  },
});

export const getInviteByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query('invites')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first();

    if (!invite) return null;

    if (invite.status === 'pending' && invite.expiresAt < Date.now()) {
      return { ...invite, status: 'expired' as const };
    }

    return invite;
  },
});

export const acceptInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query('invites')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .first();

    if (!invite) {
      throw new Error('Invalid invite');
    }

    if (invite.status !== 'pending') {
      throw new Error(`Invite has already been ${invite.status}`);
    }

    if (invite.expiresAt < Date.now()) {
      await ctx.db.patch(invite._id, { status: 'expired' });
      throw new Error('Invite has expired');
    }

    await ctx.db.patch(invite._id, {
      status: 'accepted',
      acceptedAt: Date.now(),
    });

    return { email: invite.email };
  },
});

export const listInvites = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const invites = await ctx.db.query('invites').order('desc').collect();
    const now = Date.now();
    return invites.map((invite) => {
      if (invite.status === 'pending' && invite.expiresAt < now) {
        return { ...invite, status: 'expired' as const };
      }
      return invite;
    });
  },
});

export const revokeInvite = mutation({
  args: { inviteId: v.id('invites') },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const invite = await ctx.db.get(args.inviteId);
    if (!invite) {
      throw new Error('Invite not found');
    }

    if (invite.status !== 'pending') {
      throw new Error('Can only revoke pending invites');
    }

    await ctx.db.patch(args.inviteId, { status: 'expired' });
  },
});
