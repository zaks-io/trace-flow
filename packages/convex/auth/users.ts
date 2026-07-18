import { mutation, query, internalMutation, internalQuery } from '../_generated/server';
import { v } from 'convex/values';
import { type QueryCtx, type MutationCtx } from '../_generated/server';
import { type Doc, type Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { createOrgWithDefaultBilling, ensureOrgHasSubscription } from './organizations';
import { getCurrentUser, requireEnabledUser } from './userHelpers';
import { userValidator } from '../validators';
import { rateLimiter } from '../rateLimits';

type AuthContext = QueryCtx | MutationCtx;

export { getCurrentUser, requireEnabledUser };

/**
 * Extracts the Auth0 `sub` claim from Convex's tokenIdentifier.
 * tokenIdentifier format: "<issuer>|<subject>" e.g. "https://domain.auth0.com/|auth0|12345"
 * Auth0 sub format: "auth0|12345"
 */
export function extractSub(tokenIdentifier: string): string | null {
  // Split on the issuer separator (URL ending with /|)
  const idx = tokenIdentifier.indexOf('/|');
  if (idx === -1) {
    console.warn('extractSub: unexpected tokenIdentifier format', {
      tokenIdentifier: `${tokenIdentifier.slice(0, 20)}...`,
    });
    return null;
  }
  return tokenIdentifier.slice(idx + 2);
}

interface UserInfo {
  tokenIdentifier: string;
  email: string;
  name?: string;
  picture?: string;
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function hasUserDataChanged(existingUser: Doc<'users'>, newUserInfo: UserInfo): boolean {
  return (
    existingUser.email !== newUserInfo.email ||
    existingUser.name !== newUserInfo.name ||
    existingUser.picture !== newUserInfo.picture
  );
}

async function scheduleUserOrgSync(
  ctx: MutationCtx,
  tokenIdentifier: string,
  orgId: Id<'organizations'>,
) {
  const sub = extractSub(tokenIdentifier);
  if (sub) {
    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncUserOrgToKV, {
      sub,
      orgId,
    });
  }
}

async function scheduleUserOrgRemoval(ctx: MutationCtx, tokenIdentifier: string) {
  const sub = extractSub(tokenIdentifier);
  if (sub) {
    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.deleteUserOrgFromKV, { sub });
  }
}

async function revokeApiKeysForUser(ctx: MutationCtx, userId: Id<'users'>) {
  const keys = await ctx.db
    .query('apiKeys')
    .withIndex('by_user_id', (q) => q.eq('userId', userId))
    .collect();

  for (const key of keys) {
    await ctx.db.delete(key._id);
    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.deleteKeyFromKV, {
      key: key.key,
    });
  }
}

async function revokeCollectorCredentialsForUser(ctx: MutationCtx, userId: Id<'users'>) {
  const credentials = await ctx.db
    .query('collectorCredentials')
    .withIndex('by_user_id', (q) => q.eq('userId', userId))
    .collect();

  for (const credential of credentials) {
    if (credential.status !== 'revoked') {
      await ctx.db.patch(credential._id, {
        status: 'revoked',
        revokedAt: Date.now(),
      });
    }

    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.deleteCollectorCredFromKV, {
      hashedSecret: credential.hashedSecret,
    });
  }
}

async function revokeCredentialsForRemovedUser(ctx: MutationCtx, userId: Id<'users'>) {
  await revokeApiKeysForUser(ctx, userId);
  await revokeCollectorCredentialsForUser(ctx, userId);
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

async function getAcceptedInviteForEmail(ctx: MutationCtx, email: string) {
  const normalizedEmail = normalizeEmail(email);

  return await ctx.db
    .query('invites')
    .withIndex('by_email', (q) => q.eq('email', normalizedEmail))
    .filter((q) => q.eq(q.field('status'), 'accepted'))
    .first();
}

/**
 * Applies an accepted invite for this email: org membership, inviteId, optional org switch.
 * Runs for self-serve users too so org invites still work after the user is already enabled.
 */
async function reconcileAcceptedInvite(
  ctx: MutationCtx,
  userId: Id<'users'>,
  user: Doc<'users'>,
  userInfo: UserInfo,
) {
  const acceptedInvite = await getAcceptedInviteForEmail(ctx, userInfo.email);
  if (!acceptedInvite) return;

  if (user.inviteId === acceptedInvite._id) {
    if (acceptedInvite.orgId) {
      await ensureOrgMembership(ctx, acceptedInvite.orgId, userId, 'member');
      await ensureOrgHasSubscription(ctx, acceptedInvite.orgId);
    }
    return;
  }

  let nextOrgId = user.orgId;
  if (acceptedInvite.orgId) {
    // Invited org becomes the user's active org; prior personal org remains in DB but is unlinked from users.orgId.
    nextOrgId = acceptedInvite.orgId;
  }

  await ctx.db.patch(userId, {
    inviteId: acceptedInvite._id,
    orgId: nextOrgId,
  });

  if (acceptedInvite.orgId) {
    await ensureOrgMembership(ctx, acceptedInvite.orgId, userId, 'member');
  }

  if (nextOrgId) {
    await scheduleUserOrgSync(ctx, userInfo.tokenIdentifier, nextOrgId);
    await ensureOrgHasSubscription(ctx, nextOrgId);
  }
}

export async function getCurrentUserId(ctx: AuthContext): Promise<Id<'users'> | null> {
  const user = await getCurrentUser(ctx);
  return user?._id ?? null;
}

export async function requireAdmin(ctx: AuthContext): Promise<Doc<'users'>> {
  const user = await requireEnabledUser(ctx);
  if (!user.isAdmin) {
    throw new Error('Admin access required');
  }
  return user;
}

export const removeMember = mutation({
  args: { memberId: v.id('organizationMembers') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await requireEnabledUser(ctx);
    if (!caller.orgId) throw new Error('No organization');

    // Verify caller is an active owner before revealing anything about the target
    const callerMembership = await ctx.db
      .query('organizationMembers')
      .withIndex('by_user_id', (q) => q.eq('userId', caller._id))
      .filter((q) => q.eq(q.field('orgId'), caller.orgId!))
      .first();
    if (callerMembership?.role !== 'owner' || callerMembership?.status !== 'active') {
      throw new Error('Only the organization owner can remove members');
    }

    const membership = await ctx.db.get(args.memberId);
    if (membership?.orgId !== caller.orgId) {
      throw new Error('Member not found');
    }
    if (membership.role === 'owner') {
      throw new Error('Cannot remove the organization owner');
    }

    await ctx.db.patch(args.memberId, {
      status: 'removed',
      removedAt: Date.now(),
    });

    // Clear the removed user's orgId and revoke their KV mapping
    const removedUser = await ctx.db.get(membership.userId);
    if (removedUser) {
      // Expire the accepted invite that ties this user to the org and drop the matching inviteId.
      // Otherwise the next login reconciles the still-accepted invite and silently re-activates the
      // membership we just removed. A genuine re-invite creates a fresh invite, so this is safe.
      const acceptedInvite = await getAcceptedInviteForEmail(ctx, removedUser.email);
      const inviteTiesToOrg = acceptedInvite?.orgId === membership.orgId;
      const clearInviteId =
        inviteTiesToOrg && removedUser.inviteId === acceptedInvite?._id
          ? { inviteId: undefined }
          : {};
      await ctx.db.patch(removedUser._id, { orgId: undefined, ...clearInviteId });
      if (acceptedInvite && inviteTiesToOrg) {
        await ctx.db.patch(acceptedInvite._id, { status: 'expired' });
      }
      await revokeCredentialsForRemovedUser(ctx, removedUser._id);
      if (removedUser.tokenIdentifier) {
        await scheduleUserOrgRemoval(ctx, removedUser.tokenIdentifier);
      }
    }
  },
});

export const initializeUser = mutation({
  args: {},
  returns: v.object({ userId: v.id('users') }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('Authentication required');
    }

    const email = identity.email ? normalizeEmail(identity.email) : '';
    if (!email) {
      throw new Error('User email is required');
    }

    const userInfo: UserInfo = {
      tokenIdentifier: identity.tokenIdentifier,
      email,
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

      if (!existingUser.enabled) {
        await ctx.db.patch(existingUser._id, { enabled: true });
      }

      const userAfterProfile = (await ctx.db.get(existingUser._id))!;
      await reconcileAcceptedInvite(ctx, existingUser._id, userAfterProfile, userInfo);

      const refreshed = (await ctx.db.get(existingUser._id))!;
      if (!refreshed.orgId) {
        await createOrgWithDefaultBilling(
          ctx,
          refreshed._id,
          refreshed.name,
          extractSub(userInfo.tokenIdentifier) ?? undefined,
        );
      } else {
        await ensureOrgHasSubscription(ctx, refreshed.orgId);
      }

      return { userId: existingUser._id };
    }

    await rateLimiter.limit(ctx, 'initializeUser', {
      key: identity.tokenIdentifier,
      throws: true,
    });

    const acceptedInvite = await getAcceptedInviteForEmail(ctx, userInfo.email);

    const userId = await ctx.db.insert('users', {
      ...userInfo,
      enabled: true,
      inviteId: acceptedInvite?._id,
    });

    if (acceptedInvite?.orgId) {
      await ctx.db.patch(userId, { orgId: acceptedInvite.orgId });
      await ensureOrgMembership(ctx, acceptedInvite.orgId, userId, 'member');
      await scheduleUserOrgSync(ctx, userInfo.tokenIdentifier, acceptedInvite.orgId);
      await ensureOrgHasSubscription(ctx, acceptedInvite.orgId);
    } else {
      await createOrgWithDefaultBilling(
        ctx,
        userId,
        userInfo.name,
        extractSub(userInfo.tokenIdentifier) ?? undefined,
      );
    }

    return { userId };
  },
});

export const getCurrentUserQuery = query({
  args: {},
  returns: v.union(userValidator, v.null()),
  handler: async (ctx) => {
    return await getCurrentUser(ctx);
  },
});

export const getUser = query({
  args: { id: v.id('users') },
  returns: v.union(userValidator, v.null()),
  handler: async (ctx, args) => {
    const currentUser = await getCurrentUser(ctx);
    if (!currentUser) throw new Error('Authentication required');
    const target = await ctx.db.get(args.id);
    if (!target) return null;
    // Only allow viewing users in the same org. Guard against two org-less users (both orgId
    // undefined) matching each other, which would leak profile data across the tenant boundary.
    if (!currentUser.orgId || target.orgId !== currentUser.orgId) return null;
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
  returns: v.id('users'),
  handler: async (ctx, args): Promise<Id<'users'>> => {
    const email = normalizeEmail(args.email);
    if (!email) {
      throw new Error('User email is required');
    }

    const existingUser = await ctx.db
      .query('users')
      .withIndex('by_token_identifier', (q) => q.eq('tokenIdentifier', args.tokenIdentifier))
      .first();

    if (existingUser) {
      if (
        existingUser.email !== email ||
        existingUser.name !== args.name ||
        existingUser.picture !== args.picture
      ) {
        await ctx.db.patch(existingUser._id, {
          email,
          name: args.name,
          picture: args.picture,
        });
      }
      if (!existingUser.enabled) {
        await ctx.db.patch(existingUser._id, { enabled: true });
      }

      const userInfo: UserInfo = {
        tokenIdentifier: args.tokenIdentifier,
        email,
        name: args.name,
        picture: args.picture,
      };
      const userAfterProfile = (await ctx.db.get(existingUser._id))!;
      await reconcileAcceptedInvite(ctx, existingUser._id, userAfterProfile, userInfo);

      const refreshed = (await ctx.db.get(existingUser._id))!;
      if (!refreshed.orgId) {
        await createOrgWithDefaultBilling(
          ctx,
          refreshed._id,
          refreshed.name,
          extractSub(args.tokenIdentifier) ?? undefined,
        );
      } else {
        await ensureOrgHasSubscription(ctx, refreshed.orgId);
      }
      return existingUser._id;
    }

    const acceptedInvite = await getAcceptedInviteForEmail(ctx, email);

    const userId = await ctx.db.insert('users', {
      tokenIdentifier: args.tokenIdentifier,
      email,
      name: args.name,
      picture: args.picture,
      enabled: true,
      inviteId: acceptedInvite?._id,
    });

    if (acceptedInvite?.orgId) {
      await ctx.db.patch(userId, { orgId: acceptedInvite.orgId });
      await ensureOrgMembership(ctx, acceptedInvite.orgId, userId, 'member');
      await scheduleUserOrgSync(ctx, args.tokenIdentifier, acceptedInvite.orgId);
      await ensureOrgHasSubscription(ctx, acceptedInvite.orgId);
    } else {
      await createOrgWithDefaultBilling(
        ctx,
        userId,
        args.name,
        extractSub(args.tokenIdentifier) ?? undefined,
      );
    }

    return userId;
  },
});

export const getUserById = internalQuery({
  args: { id: v.id('users') },
  returns: v.union(userValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getUserByTokenIdentifier = internalQuery({
  args: { tokenIdentifier: v.string() },
  returns: v.union(userValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('users')
      .withIndex('by_token_identifier', (q) => q.eq('tokenIdentifier', args.tokenIdentifier))
      .first();
  },
});

export const isAdmin = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user?.isAdmin === true;
  },
});

export const isAdminInternal = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    return user?.isAdmin === true;
  },
});
