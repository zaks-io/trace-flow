/**
 * Shared MCP access-token JWT contract. Convex (the OAuth issuer on
 * `connect.`) signs access tokens with the RS256 private key; the MCP worker
 * verifies them against the public key published at {@link JWKS_PATH}. Both
 * sides agree on these constants so a token minted by one verifies in the
 * other.
 */
export const MCP_ACCESS_TOKEN_ALG = 'RS256';

/** Current signing key id. Bump (and publish both keys in the JWKS) to rotate. */
export const MCP_ACCESS_TOKEN_KID = 'mcp-rs256-v1';

export const MCP_ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour

/** Path on `connect.` where the public verification key(s) are served. */
export const JWKS_PATH = '/.well-known/jwks.json';

export interface AccessTokenPayload {
  userId: string;
  tokenId: string;
}
