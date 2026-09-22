import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { generateCollectorSecret, hashCollectorSecret } from './collectorCredentials';
import { rateLimiter } from './rateLimits';
import type { Id } from './_generated/dataModel';
import { getActiveOrganizationMembership } from './auth/userHelpers';

// Server-side half of the CLI `trace-flow login` device flow. The public `collectorCredentials.mint`
// mutation requires a live Convex auth session (`ctx.auth`), which an HTTP callback resolving an Auth0
// code does not have — the callback authenticates the user itself via the existing `/collector/callback`
// → `findOrCreateUser` path, then calls this internal mutation with the resolved `userId`. It mirrors
// `mint` exactly (same rate limit, same KV sync, secret returned once) minus the session check, so the
// CLI path and the future web UI path mint identical credentials.

/** The org a freshly-authenticated user is bound to. `findOrCreateUser` guarantees one exists. */
export const resolveLoginOrg = internalQuery({
  args: { userId: v.id('users') },
  returns: v.union(v.null(), v.object({ orgId: v.id('organizations'), orgName: v.string() })),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    const active = await getActiveOrganizationMembership(ctx, user);
    if (!active) return null;
    return { orgId: active.orgId, orgName: active.organization.name };
  },
});

/**
 * Mint a Collector Credential for an already-authenticated `userId`. Returns the plaintext secret
 * exactly once; only its SHA-256 hash is stored and synced to KV. Throws if the user has no org.
 */
export const mintForUser = internalMutation({
  args: {
    userId: v.id('users'),
    collectorId: v.string(),
    name: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  returns: v.object({
    id: v.id('collectorCredentials'),
    secret: v.string(),
    orgId: v.id('organizations'),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user?.enabled) {
      throw new Error('User account is not enabled. Please contact support.');
    }
    const active = await getActiveOrganizationMembership(ctx, user);
    if (!active) throw new Error('Active organization membership required');
    const orgId: Id<'organizations'> = active.orgId;

    await rateLimiter.limit(ctx, 'mintCollectorCredential', { key: args.userId, throws: true });

    const createdAt = Date.now();
    const secret = generateCollectorSecret();
    const hashedSecret = await hashCollectorSecret(secret);

    const id = await ctx.db.insert('collectorCredentials', {
      hashedSecret,
      orgId,
      userId: args.userId,
      collectorId: args.collectorId,
      name: args.name,
      platform: args.platform,
      status: 'active',
    });

    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncCollectorCredToKV, {
      hashedSecret,
      orgId,
      userId: args.userId,
      collectorId: args.collectorId,
      status: 'active',
      createdAt,
    });

    return { id, secret, orgId };
  },
});
