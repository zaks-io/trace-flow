import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { requireAdmin, requireEnabledUser } from './users';

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
      orgId: admin.orgId,
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

export const createOrgInvite = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await requireEnabledUser(ctx);
    const orgId = user.orgId;
    if (!orgId) throw new Error('No organization found');

    const org = await ctx.db.get(orgId);
    if (!org) throw new Error('Organization not found');
    if (org.ownerId !== user._id) {
      throw new Error('Only organization owners can invite members');
    }

    const email = args.email.toLowerCase().trim();
    const existing = await ctx.db
      .query('invites')
      .withIndex('by_email', (q) => q.eq('email', email))
      .filter((q) => q.eq(q.field('status'), 'pending'))
      .first();

    if (existing) {
      throw new Error('A pending invite already exists for this email');
    }

    // Check seat limits before creating the invite
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .first();
    if (!subscription) {
      throw new Error('Organization subscription not found');
    }

    const activeMembers = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', orgId).eq('status', 'active'))
      .collect();

    const pendingInvites = await ctx.db
      .query('invites')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', orgId).eq('status', 'pending'))
      .collect();

    if (activeMembers.length + pendingInvites.length >= subscription.seatQuantity) {
      throw new Error(
        'Organization has reached its seat limit. Upgrade your plan to add more members.',
      );
    }

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    const inviteId = await ctx.db.insert('invites', {
      email,
      invitedBy: user._id,
      orgId,
      status: 'pending',
      token,
      expiresAt,
    });

    await ctx.scheduler.runAfter(0, internal.emails.sendInviteEmail, { email, token });
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

    const inviteOrgId = invite.orgId;
    if (inviteOrgId) {
      const subscription = await ctx.db
        .query('subscriptions')
        .withIndex('by_org_id', (q) => q.eq('orgId', inviteOrgId))
        .first();
      if (!subscription) {
        throw new Error('Organization subscription not found');
      }

      const seatLimit = subscription.seatQuantity;
      const activeMembers = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_id_status', (q) => q.eq('orgId', inviteOrgId).eq('status', 'active'))
        .collect();

      const pendingInvites = await ctx.db
        .query('invites')
        .withIndex('by_org_id_status', (q) => q.eq('orgId', inviteOrgId).eq('status', 'pending'))
        .collect();

      // Use > because the current invite being accepted is one of the pending invites
      if (activeMembers.length + pendingInvites.length > seatLimit) {
        throw new Error(
          'Organization has reached its seat limit. Ask the owner to increase seats in billing settings.',
        );
      }
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
