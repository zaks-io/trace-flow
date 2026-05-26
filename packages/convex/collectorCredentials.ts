import { mutation, query, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import { internal } from './_generated/api';
import { requireEnabledUser } from './auth/users';
import { collectorCredentialPublicValidator, collectorCredentialValidator } from './validators';
import { rateLimiter } from './rateLimits';
import type { Doc } from './_generated/dataModel';

// Collector Credentials are hidden desktop credentials, deliberately NOT
// user-facing API keys: they never appear in `apiKeys.list`, never become an
// `api_keys` JWT fixed_param, and cannot call the Proxy. Only the SHA-256 hash
// of the secret is stored; the plaintext is shown once at mint and otherwise
// lives in the desktop's Stronghold.

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a fresh, high-entropy Collector Credential secret. Exported for tests. */
export function generateCollectorSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `tfc_${base64Url(bytes)}`;
}

/** SHA-256 hex of a secret — the only form stored or synced to KV. */
export async function hashCollectorSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Strip the secret hash before a credential leaves the server. */
function toPublic(cred: Doc<'collectorCredentials'>) {
  const { hashedSecret: _hashedSecret, ...rest } = cred;
  return rest;
}

export const list = query({
  args: {},
  returns: v.array(collectorCredentialPublicValidator),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);
    if (!user.orgId) return [];
    const orgId = user.orgId;

    const creds = await ctx.db
      .query('collectorCredentials')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect();
    return creds.map(toPublic);
  },
});

export const mint = mutation({
  args: {
    collectorId: v.string(),
    expiresAt: v.number(),
    name: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  returns: v.object({ id: v.id('collectorCredentials'), secret: v.string() }),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);
    if (!user.orgId) {
      throw new Error('Collector Credentials require an organization');
    }

    await rateLimiter.limit(ctx, 'mintCollectorCredential', { key: user._id, throws: true });

    const secret = generateCollectorSecret();
    const hashedSecret = await hashCollectorSecret(secret);
    const createdAt = Date.now();

    const id = await ctx.db.insert('collectorCredentials', {
      hashedSecret,
      orgId: user.orgId,
      userId: user._id,
      collectorId: args.collectorId,
      name: args.name,
      platform: args.platform,
      status: 'active',
      expiresAt: args.expiresAt,
    });

    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncCollectorCredToKV, {
      hashedSecret,
      orgId: user.orgId,
      userId: user._id,
      collectorId: args.collectorId,
      expiresAt: args.expiresAt,
      status: 'active',
      createdAt,
    });

    // Returned ONCE. The plaintext is never stored or queryable after this.
    return { id, secret };
  },
});

export const revoke = mutation({
  args: { id: v.id('collectorCredentials') },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const user = await requireEnabledUser(ctx);

    const cred = await ctx.db.get(args.id);
    if (!cred) {
      throw new Error('Collector Credential not found');
    }

    // Cross-org isolation: a credential is only visible within its own org.
    if (cred.orgId !== user.orgId) {
      throw new Error('You do not have permission to revoke this Collector Credential');
    }

    // Owner of the credential, or the org owner (admin), may revoke.
    const org = await ctx.db.get(cred.orgId);
    const isOrgOwner = org?.ownerId === user._id;
    if (cred.userId !== user._id && !isOrgOwner) {
      throw new Error('You do not have permission to revoke this Collector Credential');
    }

    if (cred.status === 'revoked') return null;

    await ctx.db.patch(args.id, { status: 'revoked', revokedAt: Date.now() });

    // Remove from KV so the secret hash can no longer authenticate at the edge.
    await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.deleteCollectorCredFromKV, {
      hashedSecret: cred.hashedSecret,
    });

    return null;
  },
});

export const getByIdInternal = internalQuery({
  args: { id: v.id('collectorCredentials') },
  returns: v.union(v.null(), collectorCredentialValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const listByOrgId = internalQuery({
  args: { orgId: v.id('organizations') },
  returns: v.array(collectorCredentialValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('collectorCredentials')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .collect();
  },
});
