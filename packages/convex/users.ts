import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { type QueryCtx, type MutationCtx } from './_generated/server';
import { type Doc, type Id } from './_generated/dataModel';

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
      return { userId: existingUser._id };
    }

    const userId = await ctx.db.insert('users', {
      ...userInfo,
      enabled: false,
    });

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
    return await ctx.db.get(args.id);
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
      return existingUser._id;
    }

    return await ctx.db.insert('users', {
      tokenIdentifier: args.tokenIdentifier,
      email: args.email,
      name: args.name,
      picture: args.picture,
      enabled: false,
    });
  },
});

export const getUserById = internalQuery({
  args: { id: v.id('users') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});
