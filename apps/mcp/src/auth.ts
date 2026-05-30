import { jwtVerify, createRemoteJWKSet } from 'jose';
import { JWKS_PATH, MCP_ACCESS_TOKEN_ALG, type AccessTokenPayload } from '@trace-flow/mcp-core';

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

/**
 * Verifies an MCP access token against the RS256 public key published by
 * `connect.` at {@link JWKS_PATH}. Returns the identity payload, or null if the
 * token is missing, malformed, expired, or signed by an unknown key. The
 * signing key never reaches the worker.
 */
export async function verifyAccessToken(
  token: string,
  connectBaseUrl: string,
): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwks(connectBaseUrl), {
      algorithms: [MCP_ACCESS_TOKEN_ALG],
    });
    if (typeof payload.userId !== 'string' || typeof payload.tokenId !== 'string') {
      return null;
    }
    return { userId: payload.userId, tokenId: payload.tokenId };
  } catch {
    return null;
  }
}
