import { SignJWT, jwtVerify, importSPKI } from 'jose';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { sha256Hex } from '@trace-flow/utils';
import {
  MCP_ACCESS_TOKEN_ALG,
  MCP_ACCESS_TOKEN_KID,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenPayload,
} from '@trace-flow/mcp-core';
import { getSigningKey } from './keys';

const ACCESS_TOKEN_TTL_SECONDS = MCP_ACCESS_TOKEN_TTL_SECONDS;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const oauthGrantResultValidator = v.union(
  v.object({ error: v.string(), error_description: v.string() }),
  v.object({ userId: v.id('users'), tokenId: v.string(), resource: v.string() }),
);

export type { AccessTokenPayload };

let verificationKeyCache: { pem: string; key: Promise<CryptoKey> } | null = null;

function getVerificationKey(publicKeyPem: string): Promise<CryptoKey> {
  if (verificationKeyCache?.pem !== publicKeyPem) {
    verificationKeyCache = {
      pem: publicKeyPem,
      key: importSPKI(publicKeyPem, MCP_ACCESS_TOKEN_ALG),
    };
  }
  return verificationKeyCache.key;
}

interface RefreshTokenReadCtx {
  db: QueryCtx['db'];
}

interface RefreshTokenWriteCtx {
  db: MutationCtx['db'];
  scheduler: MutationCtx['scheduler'];
}

interface RefreshTokenInsert {
  hashedTokenId: string;
  userId: Id<'users'>;
  clientId: string;
  resource: string;
  auth0RefreshToken: string;
  expiresAt: number;
}

function refreshTokenExpiresAt(): number {
  return Date.now() + REFRESH_TOKEN_TTL_MS;
}

async function getRefreshTokenByHash(
  ctx: RefreshTokenReadCtx,
  hashedTokenId: string,
): Promise<Doc<'mcpRefreshTokens'> | null> {
  return ctx.db
    .query('mcpRefreshTokens')
    .withIndex('by_token_id', (q) => q.eq('hashedTokenId', hashedTokenId))
    .first();
}

async function getRefreshTokenByTokenId(
  ctx: RefreshTokenReadCtx,
  tokenId: string,
): Promise<{ hashedTokenId: string; token: Doc<'mcpRefreshTokens'> | null }> {
  const hashedTokenId = await sha256Hex(tokenId);
  return { hashedTokenId, token: await getRefreshTokenByHash(ctx, hashedTokenId) };
}

async function scheduleRefreshTokenCleanup(
  ctx: RefreshTokenWriteCtx,
  hashedTokenId: string,
  expiresAt: number,
): Promise<void> {
  await ctx.scheduler.runAt(expiresAt, internal.mcp.tokens.cleanupRefreshToken, {
    hashedTokenId,
  });
}

async function insertRefreshTokenRecord(
  ctx: RefreshTokenWriteCtx,
  token: RefreshTokenInsert,
): Promise<void> {
  await ctx.db.insert('mcpRefreshTokens', token);
  await scheduleRefreshTokenCleanup(ctx, token.hashedTokenId, token.expiresAt);
}

export async function createAccessToken(
  userId: string,
  tokenId: string,
  issuer: string,
  resource: string,
): Promise<string> {
  const signingKey = await getSigningKey();

  return new SignJWT({ userId, tokenId })
    .setProtectedHeader({ alg: MCP_ACCESS_TOKEN_ALG, kid: MCP_ACCESS_TOKEN_KID })
    .setIssuer(issuer)
    .setAudience(resource)
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setIssuedAt()
    .sign(signingKey);
}

export async function validateAccessToken(
  token: string,
  issuer: string,
  resource: string,
): Promise<AccessTokenPayload | null> {
  const publicKeyPem = process.env.MCP_JWT_PUBLIC_KEY;
  if (!publicKeyPem) {
    throw new Error('MCP_JWT_PUBLIC_KEY not configured');
  }

  try {
    const publicKey = await getVerificationKey(publicKeyPem);
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [MCP_ACCESS_TOKEN_ALG],
      issuer,
      audience: resource,
    });
    return payload as unknown as AccessTokenPayload;
  } catch {
    return null;
  }
}

export const createRefreshToken = internalMutation({
  args: {
    userId: v.id('users'),
    clientId: v.string(),
    resource: v.string(),
    auth0RefreshToken: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const tokenId = crypto.randomUUID();
    const hashedTokenId = await sha256Hex(tokenId);
    await insertRefreshTokenRecord(ctx, {
      hashedTokenId,
      userId: args.userId,
      clientId: args.clientId,
      resource: args.resource,
      auth0RefreshToken: args.auth0RefreshToken,
      expiresAt: refreshTokenExpiresAt(),
    });

    return tokenId;
  },
});

export const getRefreshToken = internalQuery({
  args: { tokenId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id('mcpRefreshTokens'),
      _creationTime: v.number(),
      tokenId: v.optional(v.string()),
      hashedTokenId: v.string(),
      userId: v.id('users'),
      clientId: v.optional(v.string()),
      resource: v.optional(v.string()),
      auth0RefreshToken: v.string(),
      expiresAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const { token } = await getRefreshTokenByTokenId(ctx, args.tokenId);

    if (!token) {
      return null;
    }

    if (token.expiresAt < Date.now()) {
      return null;
    }

    return token;
  },
});

export const deleteRefreshToken = internalMutation({
  args: { tokenId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const { token } = await getRefreshTokenByTokenId(ctx, args.tokenId);

    if (token) {
      await ctx.db.delete(token._id);
    }
  },
});

export const updateRefreshToken = internalMutation({
  args: {
    tokenId: v.string(),
    auth0RefreshToken: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const { hashedTokenId, token } = await getRefreshTokenByTokenId(ctx, args.tokenId);

    if (token) {
      const expiresAt = refreshTokenExpiresAt();
      await ctx.db.patch(token._id, {
        auth0RefreshToken: args.auth0RefreshToken,
        expiresAt,
      });
      await scheduleRefreshTokenCleanup(ctx, hashedTokenId, expiresAt);
    }
  },
});

export const rotateRefreshToken = internalMutation({
  args: {
    tokenId: v.string(),
    clientId: v.string(),
    resource: v.string(),
    auth0RefreshToken: v.string(),
  },
  returns: oauthGrantResultValidator,
  handler: async (ctx, args) => {
    const { token } = await getRefreshTokenByTokenId(ctx, args.tokenId);

    if (
      !token ||
      token.expiresAt < Date.now() ||
      token.clientId !== args.clientId ||
      token.resource !== args.resource
    ) {
      return { error: 'invalid_grant', error_description: 'Invalid or expired refresh token' };
    }

    const tokenId = crypto.randomUUID();
    const hashedTokenId = await sha256Hex(tokenId);

    await ctx.db.delete(token._id);
    await insertRefreshTokenRecord(ctx, {
      hashedTokenId,
      userId: token.userId,
      clientId: args.clientId,
      resource: args.resource,
      auth0RefreshToken: args.auth0RefreshToken,
      expiresAt: refreshTokenExpiresAt(),
    });

    return { userId: token.userId, tokenId, resource: args.resource };
  },
});

export const deleteUserRefreshTokens = internalMutation({
  args: { userId: v.id('users') },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const tokens = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
      .collect();

    for (const token of tokens) {
      await ctx.db.delete(token._id);
    }
  },
});

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const createAuthCode = internalMutation({
  args: {
    userId: v.id('users'),
    clientId: v.string(),
    redirectUri: v.string(),
    resource: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.literal('S256'),
    auth0RefreshToken: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const code = crypto.randomUUID();
    const expiresAt = Date.now() + AUTH_CODE_TTL_MS;

    await ctx.db.insert('mcpAuthCodes', {
      code,
      userId: args.userId,
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      resource: args.resource,
      codeChallenge: args.codeChallenge,
      codeChallengeMethod: args.codeChallengeMethod,
      auth0RefreshToken: args.auth0RefreshToken,
      expiresAt,
      used: false,
    });

    await ctx.scheduler.runAt(expiresAt, internal.mcp.tokens.cleanupAuthCode, { code });

    return code;
  },
});

export const exchangeAuthCode = internalMutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    resource: v.string(),
    codeVerifier: v.string(),
  },
  returns: oauthGrantResultValidator,
  handler: async (ctx, args) => {
    const authCode = await ctx.db
      .query('mcpAuthCodes')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .first();

    if (!authCode) {
      return { error: 'invalid_grant', error_description: 'Authorization code not found' };
    }

    if (authCode.used) {
      return { error: 'invalid_grant', error_description: 'Authorization code already used' };
    }

    if (authCode.expiresAt < Date.now()) {
      return { error: 'invalid_grant', error_description: 'Authorization code expired' };
    }

    if (authCode.redirectUri !== args.redirectUri) {
      return { error: 'invalid_grant', error_description: 'Redirect URI mismatch' };
    }

    if (!authCode.clientId || authCode.clientId !== args.clientId) {
      return { error: 'invalid_grant', error_description: 'Client ID mismatch' };
    }

    if (!authCode.resource || authCode.resource !== args.resource) {
      return { error: 'invalid_grant', error_description: 'Resource mismatch' };
    }

    if (!authCode.codeChallenge || authCode.codeChallengeMethod !== 'S256') {
      return { error: 'invalid_grant', error_description: 'PKCE challenge missing' };
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(args.codeVerifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const base64Hash = btoa(String.fromCharCode(...hashArray))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    if (base64Hash !== authCode.codeChallenge) {
      return { error: 'invalid_grant', error_description: 'Code verifier mismatch' };
    }

    // Mark code as used
    await ctx.db.patch(authCode._id, { used: true });

    // Create refresh token
    const tokenId = crypto.randomUUID();
    const hashedTokenId = await sha256Hex(tokenId);

    await insertRefreshTokenRecord(ctx, {
      hashedTokenId,
      userId: authCode.userId,
      clientId: authCode.clientId,
      resource: authCode.resource,
      auth0RefreshToken: authCode.auth0RefreshToken,
      expiresAt: refreshTokenExpiresAt(),
    });

    return {
      userId: authCode.userId,
      tokenId,
      resource: authCode.resource,
    };
  },
});

export { ACCESS_TOKEN_TTL_SECONDS };

export const cleanupRefreshToken = internalMutation({
  args: { hashedTokenId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const token = await getRefreshTokenByHash(ctx, args.hashedTokenId);

    if (token && token.expiresAt <= Date.now()) {
      await ctx.db.delete(token._id);
    }
  },
});

export const cleanupAuthCode = internalMutation({
  args: { code: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const authCode = await ctx.db
      .query('mcpAuthCodes')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .first();

    if (authCode) {
      await ctx.db.delete(authCode._id);
    }
  },
});
