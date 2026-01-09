import { SignJWT, jwtVerify } from 'jose';
import { internalMutation, internalQuery } from '../_generated/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';

const ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AccessTokenPayload {
  userId: string;
  tokenId: string;
}

export async function createAccessToken(userId: string, tokenId: string): Promise<string> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  return new SignJWT({ userId, tokenId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setIssuedAt()
    .sign(secretKey);
}

export async function validateAccessToken(token: string): Promise<AccessTokenPayload | null> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, secretKey);
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
  handler: async (ctx, args): Promise<string> => {
    const tokenId = crypto.randomUUID();
    const expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;

    await ctx.db.insert('mcpRefreshTokens', {
      tokenId,
      userId: args.userId,
      auth0RefreshToken: args.auth0RefreshToken,
      expiresAt,
    });

    await ctx.scheduler.runAt(expiresAt, internal.mcp.tokens.cleanupRefreshToken, { tokenId });

    return tokenId;
  },
});

export const getRefreshToken = internalQuery({
  args: { tokenId: v.string() },
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_token_id', (q) => q.eq('tokenId', args.tokenId))
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
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_token_id', (q) => q.eq('tokenId', args.tokenId))
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
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_token_id', (q) => q.eq('tokenId', args.tokenId))
      .first();

    if (token) {
      const expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;
      await ctx.db.patch(token._id, {
        auth0RefreshToken: args.auth0RefreshToken,
        expiresAt,
      });
      await ctx.scheduler.runAt(expiresAt, internal.mcp.tokens.cleanupRefreshToken, {
        tokenId: args.tokenId,
      });
    }
  },
});

export const deleteUserRefreshTokens = internalMutation({
  args: { userId: v.id('users') },
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
    const expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;

    await ctx.db.insert('mcpRefreshTokens', {
      tokenId,
      userId: authCode.userId,
      auth0RefreshToken: authCode.auth0RefreshToken,
      expiresAt,
    });

    await ctx.scheduler.runAt(expiresAt, internal.mcp.tokens.cleanupRefreshToken, { tokenId });

    return {
      userId: authCode.userId,
      tokenId,
    };
  },
});

export { ACCESS_TOKEN_TTL_SECONDS };

export const cleanupRefreshToken = internalMutation({
  args: { tokenId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.db
      .query('mcpRefreshTokens')
      .withIndex('by_token_id', (q) => q.eq('tokenId', args.tokenId))
      .first();

    if (token && token.expiresAt <= Date.now()) {
      await ctx.db.delete(token._id);
    }
  },
});

export const cleanupAuthCode = internalMutation({
  args: { code: v.string() },
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
