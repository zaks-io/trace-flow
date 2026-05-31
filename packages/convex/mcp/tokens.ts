import { SignJWT, jwtVerify, importSPKI } from 'jose';
import { internalMutation, internalQuery } from '../_generated/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { sha256Hex } from '@trace-flow/utils';
import {
  MCP_ACCESS_TOKEN_ALG,
  MCP_ACCESS_TOKEN_AUDIENCE,
  MCP_ACCESS_TOKEN_KID,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenPayload,
} from '@trace-flow/mcp-core';
import { getSigningKey } from './keys';

const ACCESS_TOKEN_TTL_SECONDS = MCP_ACCESS_TOKEN_TTL_SECONDS;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

export async function createAccessToken(
  userId: string,
  tokenId: string,
  issuer: string,
): Promise<string> {
  const signingKey = await getSigningKey();

  return new SignJWT({ userId, tokenId })
    .setProtectedHeader({ alg: MCP_ACCESS_TOKEN_ALG, kid: MCP_ACCESS_TOKEN_KID })
    .setIssuer(issuer)
    .setAudience(MCP_ACCESS_TOKEN_AUDIENCE)
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setIssuedAt()
    .sign(signingKey);
}

export async function validateAccessToken(
  token: string,
  issuer: string,
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
      audience: MCP_ACCESS_TOKEN_AUDIENCE,
    });
    return payload as unknown as AccessTokenPayload;
  } catch {
    return null;
  }
}

export const createRefreshToken = internalMutation({
  args: {
    userId: v.id('users'),
    auth0RefreshToken: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const tokenId = crypto.randomUUID();
    const hashedTokenId = await sha256Hex(tokenId);
    const expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;

    await ctx.db.insert('mcpRefreshTokens', {
      hashedTokenId,
      userId: args.userId,
      auth0RefreshToken: args.auth0RefreshToken,
      expiresAt,
    });

    await ctx.scheduler.runAt(expiresAt, internal.mcp.tokens.cleanupRefreshToken, {
      hashedTokenId,
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
      auth0RefreshToken: v.string(),
      expiresAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const hashed = await sha256Hex(args.tokenId);
    const token = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_token_id', (q) => q.eq('hashedTokenId', hashed))
      .first();

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
    const hashed = await sha256Hex(args.tokenId);
    const token = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_token_id', (q) => q.eq('hashedTokenId', hashed))
      .first();

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
    const hashed = await sha256Hex(args.tokenId);
    const token = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_token_id', (q) => q.eq('hashedTokenId', hashed))
      .first();

    if (token) {
      const expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;
      await ctx.db.patch(token._id, {
        auth0RefreshToken: args.auth0RefreshToken,
        expiresAt,
      });
      await ctx.scheduler.runAt(expiresAt, internal.mcp.tokens.cleanupRefreshToken, {
        hashedTokenId: hashed,
      });
    }
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
    clientId: v.optional(v.string()),
    redirectUri: v.string(),
    codeChallenge: v.optional(v.string()),
    codeChallengeMethod: v.optional(v.string()),
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
    redirectUri: v.string(),
    codeVerifier: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ error: v.string(), error_description: v.string() }),
    v.object({ userId: v.id('users'), tokenId: v.string() }),
  ),
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

    // Verify PKCE if code_challenge was provided
    if (authCode.codeChallenge && authCode.codeChallengeMethod === 'S256') {
      if (!args.codeVerifier) {
        return { error: 'invalid_grant', error_description: 'Code verifier required' };
      }

      // Calculate S256 hash of verifier
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
    }

    // Mark code as used
    await ctx.db.patch(authCode._id, { used: true });

    // Create refresh token
    const tokenId = crypto.randomUUID();
    const hashedTokenId = await sha256Hex(tokenId);
    const expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;

    await ctx.db.insert('mcpRefreshTokens', {
      hashedTokenId,
      userId: authCode.userId,
      auth0RefreshToken: authCode.auth0RefreshToken,
      expiresAt,
    });

    await ctx.scheduler.runAt(expiresAt, internal.mcp.tokens.cleanupRefreshToken, {
      hashedTokenId,
    });

    return {
      userId: authCode.userId,
      tokenId,
    };
  },
});

export { ACCESS_TOKEN_TTL_SECONDS };

export const cleanupRefreshToken = internalMutation({
  args: { hashedTokenId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_token_id', (q) => q.eq('hashedTokenId', args.hashedTokenId))
      .first();

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
