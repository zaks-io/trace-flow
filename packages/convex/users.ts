import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { type QueryCtx, type MutationCtx } from './_generated/server';
import { type Doc, type Id } from './_generated/dataModel';
import { TIER_CONFIG } from '@trace-flow/types';
import { scheduleKVSync } from './subscriptions';

type AuthContext = QueryCtx | MutationCtx;

interface UserInfo {
  tokenIdentifier: string;
  email: string;
  name?: string;
  picture?: string;
}

function hasUserDataChanged(existingUser: Doc<'users'>, newUserInfo: UserInfo): boolean {
  return (
    existingUser.email !== newUserInfo.email ||
    existingUser.name !== newUserInfo.name ||
    existingUser.picture !== newUserInfo.picture
  );
}

async function ensureOrg(ctx: MutationCtx, userId: Id<'users'>, name?: string) {
  const orgId = await ctx.db.insert('organizations', {
    name: `${name ? `${name}'s Org` : 'My Organization'}`,
    ownerId: userId,
  });
  await ctx.db.patch(userId, { orgId });
  await ctx.db.insert('organizationMembers', {
    orgId,
    userId,
    role: 'owner',
    status: 'active',
    joinedAt: Date.now(),
  });
  return orgId;
}

async function createHobbySubscription(ctx: MutationCtx, orgId: Id<'organizations'>) {
  const hobbyConfig = TIER_CONFIG.hobby;
  const now = Date.now();
  const periodEnd = now + 30 * 24 * 60 * 60 * 1000;
  const subscriptionId = await ctx.db.insert('subscriptions', {
    orgId,
    tier: 'hobby',
    status: 'active',
    monthlyUnits: hobbyConfig.monthlyUnits,
    addonUnits: 0,
    seatQuantity: 1,
    autoOverage: false,
    currentPeriodOverageSpentCents: 0,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    addonPurchaseCount: 0,
  });
  await scheduleKVSync(ctx, subscriptionId);
}

async function ensureOrgMembership(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  userId: Id<'users'>,
  role: 'owner' | 'member',
) {
  const existing = await ctx.db
    .query('organizationMembers')
    .withIndex('by_user_id', (q) => q.eq('userId', userId))
    .filter((q) => q.eq(q.field('orgId'), orgId))
    .first();

  if (existing) {
    if (existing.status !== 'active' || existing.role !== role) {
      await ctx.db.patch(existing._id, {
        status: 'active',
        role,
        joinedAt: existing.joinedAt ?? Date.now(),
        removedAt: undefined,
      });
    }
    return;
  }

  await ctx.db.insert('organizationMembers', {
    orgId,
    userId,
    role,
    status: 'active',
    joinedAt: Date.now(),
  });
}

export async function getCurrentUser(ctx: AuthContext): Promise<Doc<'users'> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  return await ctx.db
    .query('users')
    .withIndex('by_token_identifier', (q) => q.eq('tokenIdentifier', identity.tokenIdentifier))
    .first();
}

export async function getCurrentUserId(ctx: AuthContext): Promise<Id<'users'> | null> {
  const user = await getCurrentUser(ctx);
  return user?._id ?? null;
}

export async function requireEnabledUser(ctx: AuthContext): Promise<Doc<'users'>> {
  const user = await getCurrentUser(ctx);
  if (!user) {
    throw new Error('User not found. Please log in again.');
  }
  if (!user.enabled) {
    throw new Error('User account is not enabled. Please contact support.');
  }
  return user;
}

export async function requireAdmin(ctx: AuthContext): Promise<Doc<'users'>> {
  const user = await requireEnabledUser(ctx);
  if (!user.isAdmin) {
    throw new Error('Admin access required');
  }
  return user;
}

export const initializeUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('Authentication required');
    }

    if (!identity.email) {
      throw new Error('User email is required');
    }

    const userInfo: UserInfo = {
      tokenIdentifier: identity.tokenIdentifier,
      email: identity.email,
      name: identity.name,
      picture: identity.pictureUrl,
    };

    const existingUser = await ctx.db
      .query('users')
      .withIndex('by_token_identifier', (q) => q.eq('tokenIdentifier', userInfo.tokenIdentifier))
      .first();

    if (existingUser) {
      if (hasUserDataChanged(existingUser, userInfo)) {
        await ctx.db.patch(existingUser._id, userInfo);
      }
      if (!existingUser.orgId) {
        await ensureOrg(ctx, existingUser._id, existingUser.name);
      }
      // Enable user if they have an accepted invite and aren't enabled yet
      if (!existingUser.enabled && !existingUser.inviteId) {
        const acceptedInvite = await ctx.db
          .query('invites')
          .withIndex('by_email', (q) => q.eq('email', userInfo.email))
          .filter((q) => q.eq(q.field('status'), 'accepted'))
          .first();

        if (acceptedInvite) {
          let nextOrgId = existingUser.orgId;
          if (acceptedInvite.orgId) {
            nextOrgId = acceptedInvite.orgId;
          }

          await ctx.db.patch(existingUser._id, {
            enabled: true,
            inviteId: acceptedInvite._id,
            orgId: nextOrgId,
          });

          if (acceptedInvite.orgId) {
            await ensureOrgMembership(ctx, acceptedInvite.orgId, existingUser._id, 'member');
          }

          if (nextOrgId) {
            const existingSub = await ctx.db
              .query('subscriptions')
              .withIndex('by_org_id', (q) => q.eq('orgId', nextOrgId))
              .first();
            if (!existingSub) {
              await createHobbySubscription(ctx, nextOrgId);
            }
          }
        }
      }
      return { userId: existingUser._id };
    }

    // Check for accepted invite for new users
    const acceptedInvite = await ctx.db
      .query('invites')
      .withIndex('by_email', (q) => q.eq('email', userInfo.email))
      .filter((q) => q.eq(q.field('status'), 'accepted'))
      .first();

    const userId = await ctx.db.insert('users', {
      ...userInfo,
      enabled: !!acceptedInvite,
      inviteId: acceptedInvite?._id,
    });

    if (acceptedInvite?.orgId) {
      await ctx.db.patch(userId, { orgId: acceptedInvite.orgId });
      await ensureOrgMembership(ctx, acceptedInvite.orgId, userId, 'member');
    } else {
      const orgId = await ensureOrg(ctx, userId, userInfo.name);
      if (acceptedInvite) {
        await createHobbySubscription(ctx, orgId);
      }
    }

    return { userId };
  },
});

export const getCurrentUserQuery = query({
  args: {},
  handler: async (ctx) => {
    return await getCurrentUser(ctx);
  },
});

export const getUser = query({
  args: { id: v.id('users') },
  handler: async (ctx, args) => {
    const currentUser = await getCurrentUser(ctx);
    if (!currentUser) throw new Error('Authentication required');
    const target = await ctx.db.get(args.id);
    if (!target) return null;
    // Only allow viewing users in the same org
    if (target.orgId !== currentUser.orgId) return null;
    return target;
  },
});

export const findOrCreateUser = internalMutation({
  args: {
    tokenIdentifier: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    picture: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'users'>> => {
    const existingUser = await ctx.db
      .query('users')
      .withIndex('by_token_identifier', (q) => q.eq('tokenIdentifier', args.tokenIdentifier))
      .first();

    if (existingUser) {
      if (
        existingUser.email !== args.email ||
        existingUser.name !== args.name ||
        existingUser.picture !== args.picture
      ) {
        await ctx.db.patch(existingUser._id, {
          email: args.email,
          name: args.name,
          picture: args.picture,
        });
      }
      const orgId =
        existingUser.orgId ?? (await ensureOrg(ctx, existingUser._id, existingUser.name));
      const existingSub = await ctx.db
        .query('subscriptions')
        .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
        .first();
      if (!existingSub) {
        await createHobbySubscription(ctx, orgId);
      }
      return existingUser._id;
    }

    const userId = await ctx.db.insert('users', {
      tokenIdentifier: args.tokenIdentifier,
      email: args.email,
      name: args.name,
      picture: args.picture,
      enabled: false,
    });

    const orgId = await ensureOrg(ctx, userId, args.name);
    await createHobbySubscription(ctx, orgId);

    return userId;
  },
});

export const getUserById = internalQuery({
  args: { id: v.id('users') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getUserByTokenIdentifier = internalQuery({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('users')
      .withIndex('by_token_identifier', (q) => q.eq('tokenIdentifier', args.tokenIdentifier))
      .first();
  },
});

export const isAdmin = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user?.isAdmin === true;
  },
});

export const isAdminInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user?.isAdmin === true;
  },
});
