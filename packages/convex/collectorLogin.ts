import { internalMutation, type MutationCtx } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { sha256Hex } from '@trace-flow/utils';
import { generateCollectorSecret, hashCollectorSecret } from './collectorCredentials';
import { rateLimiter } from './rateLimits';
import type { Id } from './_generated/dataModel';
import { getActiveOrganizationMembership } from './auth/userHelpers';
import { s256Challenge } from './httpRoutes/mcpPkce';

const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;

const mintArgs = {
  userId: v.id('users'),
  collectorId: v.string(),
  name: v.optional(v.string()),
  platform: v.optional(v.string()),
};

interface MintArgs {
  userId: Id<'users'>;
  collectorId: string;
  name?: string;
  platform?: string;
}

/**
 * Mint a Collector Credential for an already-authenticated `userId`. Returns the plaintext secret
 * exactly once; only its SHA-256 hash is stored and synced to KV. Throws if the user has no org.
 */
async function mintCredential(ctx: MutationCtx, args: MintArgs) {
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
}

/** Collectors from before PKCE sign-in receive the credential in the loopback redirect itself. */
export const mintForUser = internalMutation({
  args: mintArgs,
  returns: v.object({
    id: v.id('collectorCredentials'),
    secret: v.string(),
    orgId: v.id('organizations'),
  }),
  handler: (ctx, args) => mintCredential(ctx, args),
});

/**
 * Record a finished sign-in and return the one-time code for the Collector's redirect. Nothing is
 * minted yet: whoever receives the redirect, such as another process listening on that port on the
 * browser's machine, still needs the PKCE verifier that only the Collector holds.
 */
export const createLoginCode = internalMutation({
  args: { userId: v.id('users'), codeChallenge: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const code = crypto.randomUUID();
    const expiresAt = Date.now() + LOGIN_CODE_TTL_MS;
    const id = await ctx.db.insert('collectorLoginCodes', {
      codeHash: await sha256Hex(code),
      userId: args.userId,
      codeChallenge: args.codeChallenge,
      expiresAt,
    });
    await ctx.scheduler.runAt(expiresAt, internal.collectorLogin.cleanupLoginCode, { id });
    return code;
  },
});

/**
 * Redeem a sign-in code with the verifier for its challenge, minting the Collector Credential. A
 * code works once. A wrong verifier leaves the code in place, so whoever caught the redirect
 * cannot spend the Collector's sign-in by guessing.
 */
export const redeemLoginCode = internalMutation({
  args: { code: v.string(), codeVerifier: v.string(), collectorId: v.string() },
  returns: v.union(
    v.object({ secret: v.string(), orgId: v.id('organizations') }),
    v.object({ error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const codeHash = await sha256Hex(args.code);
    const loginCode = await ctx.db
      .query('collectorLoginCodes')
      .withIndex('by_code_hash', (q) => q.eq('codeHash', codeHash))
      .first();
    if (!loginCode || loginCode.expiresAt < Date.now()) {
      return { error: 'Sign-in code is invalid or expired' };
    }
    if ((await s256Challenge(args.codeVerifier)) !== loginCode.codeChallenge) {
      return { error: 'Code verifier does not match' };
    }

    await ctx.db.delete(loginCode._id);
    const { secret, orgId } = await mintCredential(ctx, {
      userId: loginCode.userId,
      collectorId: args.collectorId,
      name: 'Trace Flow CLI',
      platform: 'cli',
    });
    return { secret, orgId };
  },
});

export const cleanupLoginCode = internalMutation({
  args: { id: v.id('collectorLoginCodes') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (await ctx.db.get(args.id)) {
      await ctx.db.delete(args.id);
    }
    return null;
  },
});
