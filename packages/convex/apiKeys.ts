import { mutation, query, internalQuery, type QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import {
  getActiveOrganizationMembership,
  getCurrentEnabledUser,
  requireActiveOrganizationMembership,
} from './auth/users';
import { apiKeyValidator } from './validators';
import { apiKeyPermissionValidator, type ApiKeyPermission } from './apiKeyPermissions';
import { rateLimiter } from './rateLimits';
import { analyticsKeyId } from '@trace-flow/utils';
import type { Doc } from './_generated/dataModel';

export function canAccessApiKey(
  user: Pick<Doc<'users'>, '_id' | 'orgId'>,
  apiKey: Pick<Doc<'apiKeys'>, 'userId' | 'orgId'>,
): boolean {
  if (apiKey.userId !== user._id) return false;
  return !apiKey.orgId || apiKey.orgId === user.orgId;
}

async function listAccessibleKeys(ctx: QueryCtx) {
  const user = await getCurrentEnabledUser(ctx);
  if (!user) return [];
  const active = await getActiveOrganizationMembership(ctx, user);
  if (!active) return [];

  const userKeys = await ctx.db
    .query('apiKeys')
    .withIndex('by_user_id', (q) => q.eq('userId', user._id))
    .collect();
  return userKeys.filter((key) => canAccessApiKey(user, key));
}

async function listAnalyticsKeys(ctx: QueryCtx) {
  const user = await getCurrentEnabledUser(ctx);
  if (!user) return [];
  const active = await getActiveOrganizationMembership(ctx, user);
  if (!active) return [];

  const [orgKeys, userKeys] = await Promise.all([
    ctx.db
      .query('apiKeys')
      .withIndex('by_org_id', (q) => q.eq('orgId', active.orgId))
      .collect(),
    ctx.db
      .query('apiKeys')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .collect(),
  ]);
  const seen = new Set(orgKeys.map((key) => key._id));
  return [...orgKeys, ...userKeys.filter((key) => !seen.has(key._id) && !key.orgId)];
}

export const list = query({
  args: {},
  returns: v.array(apiKeyValidator),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    return listAccessibleKeys(ctx);
  },
});

export const listAnalytics = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('apiKeys'),
      name: v.optional(v.string()),
      identifier: v.string(),
    }),
  ),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const apiKeys = await listAnalyticsKeys(ctx);
    return Promise.all(
      apiKeys.map(async (apiKey) => ({
        _id: apiKey._id,
        name: apiKey.name,
        identifier: await analyticsKeyId(apiKey.key),
      })),
    );
  },
});

export const create = mutation({
  args: {
    permissions: v.optional(v.array(apiKeyPermissionValidator)),
    expiresAt: v.number(),
    name: v.optional(v.string()),
  },
  returns: v.id('apiKeys'),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { user, orgId } = await requireActiveOrganizationMembership(ctx);

    await rateLimiter.limit(ctx, 'createApiKey', { key: user._id, throws: true });

    const permissions = [...new Set<ApiKeyPermission>(args.permissions ?? ['ingest'])];
    if (permissions.length === 0) throw new Error('Choose at least one API key permission');

    const key = crypto.randomUUID();

    const id = await ctx.db.insert('apiKeys', {
      permissions,
      key,
      expiresAt: args.expiresAt,
      userId: user._id,
      orgId,
      name: args.name,
    });

    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id('apiKeys'),
    name: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { user } = await requireActiveOrganizationMembership(ctx);

    const apiKey = await ctx.db.get(args.id);
    if (!apiKey) {
      throw new Error('API key not found');
    }

    if (!canAccessApiKey(user, apiKey)) {
      throw new Error('You do not have permission to edit this API key');
    }

    const patch: { name?: string; expiresAt?: number } = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.expiresAt !== undefined) patch.expiresAt = args.expiresAt;

    await ctx.db.patch(args.id, patch);
  },
});

export const remove = mutation({
  args: { id: v.id('apiKeys') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { user } = await requireActiveOrganizationMembership(ctx);

    const apiKey = await ctx.db.get(args.id);
    if (!apiKey) {
      throw new Error('API key not found');
    }

    if (!canAccessApiKey(user, apiKey)) {
      throw new Error('You do not have permission to delete this API key');
    }

    await ctx.db.delete(args.id);
  },
});

// Internal query for MCP - resolves org membership and returns the correct keys
export const listForUser = internalQuery({
  args: { userId: v.id('users') },
  returns: v.array(apiKeyValidator),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !(await getActiveOrganizationMembership(ctx, user))) return [];

    const orgId = user.orgId;
    if (orgId) {
      const [orgKeys, userKeys] = await Promise.all([
        ctx.db
          .query('apiKeys')
          .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
          .collect(),
        ctx.db
          .query('apiKeys')
          .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
          .collect(),
      ]);
      const seen = new Set(orgKeys.map((key) => key._id));
      return [...orgKeys, ...userKeys.filter((key) => !seen.has(key._id) && !key.orgId)];
    }

    const userKeys = await ctx.db
      .query('apiKeys')
      .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
      .collect();
    return userKeys.filter((key) => canAccessApiKey(user, key));
  },
});

// Internal query to get all API keys for an organization
export const listByOrgId = internalQuery({
  args: { orgId: v.id('organizations') },
  returns: v.array(apiKeyValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('apiKeys')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .collect();
  },
});
