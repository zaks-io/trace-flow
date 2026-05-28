import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { generateCollectorSecret, hashCollectorSecret } from './collectorCredentials';
import { rateLimiter } from './rateLimits';
import type { Id } from './_generated/dataModel';

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
    if (!user?.orgId) return null;
    const org = await ctx.db.get(user.orgId);
    if (!org) return null;
    return { orgId: user.orgId, orgName: org.name };
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
    expiresAt: v.number(),
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
    if (!user?.orgId) {
      throw new Error('Collector Credentials require an organization');
    }
    const orgId: Id<'organizations'> = user.orgId;

    await rateLimiter.limit(ctx, 'mintCollectorCredential', { key: args.userId, throws: true });

    const createdAt = Date.now();
    // The credential lifetime is enforced here, at the mint boundary, not trusted from the caller.
    // The HTTP callback computes `expiresAt = now + 90d`, but this internal mutation is the auth
    // boundary for the credential, so it caps the lifetime itself: reject a past expiry and clamp to
    // at most 90 days out. A future web/desktop minter can't widen the window past this.
    const MAX_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
    if (args.expiresAt <= createdAt || args.expiresAt > createdAt + MAX_CREDENTIAL_TTL_MS) {
      throw new Error('Collector Credential expiry must be in the future and within 90 days');
    }

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
      expiresAt: args.expiresAt,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncCollectorCredToKV, {
      hashedSecret,
      orgId,
      userId: args.userId,
      collectorId: args.collectorId,
      expiresAt: args.expiresAt,
      status: 'active',
      createdAt,
    });

    return { id, secret, orgId };
  },
});
