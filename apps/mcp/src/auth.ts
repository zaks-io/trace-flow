import { jwtVerify, createRemoteJWKSet } from 'jose';
import { JWKS_PATH, MCP_ACCESS_TOKEN_ALG, type AccessTokenPayload } from '@trace-flow/mcp-core';
import type { Logger } from '@trace-flow/logging';

export class TokenVerificationUnavailableError extends Error {
  constructor() {
    super('Token verification service unavailable');
    this.name = 'TokenVerificationUnavailableError';
  }
}

// One JWKS set per connect-base URL. createRemoteJWKSet caches keys and handles
// rotation by kid, so verification is a local crypto op after the first fetch —
// no Convex round trip on the hot path.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(connectBaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(connectBaseUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_PATH, connectBaseUrl));
    jwksCache.set(connectBaseUrl, jwks);
  }
  return jwks;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function isJwksFetchError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_INVALID') {
    return true;
  }
  const message = errorMessage(error);
  if (
    code === 'ERR_JOSE_GENERIC' &&
    (message === 'Expected 200 OK from the JSON Web Key Set HTTP response' ||
      message === 'Failed to parse the JSON Web Key Set HTTP response as JSON')
  ) {
    return true;
  }
  return error instanceof TypeError;
}

/**
 * Verifies an MCP access token against the RS256 public key published by
 * `connect.` at {@link JWKS_PATH}. Returns the identity payload, or null if the
 * token is missing, malformed, expired, or signed by an unknown key. The
 * signing key never reaches the worker.
 */
export async function verifyAccessToken(
  token: string,
  connectBaseUrl: string,
  resourceUrl: string,
  logger?: Pick<Logger, 'error'>,
): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwks(connectBaseUrl), {
      algorithms: [MCP_ACCESS_TOKEN_ALG],
      issuer: connectBaseUrl,
      audience: resourceUrl,
    });
    if (typeof payload.userId !== 'string' || typeof payload.tokenId !== 'string') {
      return null;
    }
    return { userId: payload.userId, tokenId: payload.tokenId };
  } catch (error) {
    if (isJwksFetchError(error)) {
      logger?.error('mcp.auth_jwks_unavailable', error, {
        connectBaseUrl,
        phase: 'jwtVerify/getJwks',
        code: errorCode(error),
      });
      throw new TokenVerificationUnavailableError();
    }
    return null;
  }
}
