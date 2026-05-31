import { importPKCS8, importSPKI, exportJWK, type JWK, type CryptoKey } from 'jose';
import { MCP_ACCESS_TOKEN_ALG, MCP_ACCESS_TOKEN_KID } from '@trace-flow/mcp-core';

/**
 * RS256 keypair backing MCP access tokens. The private key signs tokens at the
 * OAuth `/mcp/token` endpoint; the public key is published as a JWKS so the MCP
 * worker can verify tokens with no Convex round trip. The Tinybird admin token
 * and this private key never leave Convex.
 *
 * Keys are PEM strings in env (PKCS8 for private, SPKI for public) so they
 * survive Convex's env storage without binary encoding. Generate with:
 *   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out key.pem
 *   openssl pkey -in key.pem -pubout -out pub.pem
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} not configured`);
  }
  return value;
}

let privateKeyPromise: Promise<CryptoKey> | null = null;
let publicJwkPromise: Promise<JWK> | null = null;

export function getSigningKey(): Promise<CryptoKey> {
  privateKeyPromise ??= importPKCS8(requireEnv('MCP_JWT_PRIVATE_KEY'), MCP_ACCESS_TOKEN_ALG).catch(
    (error) => {
      privateKeyPromise = null;
      throw error;
    },
  );
  return privateKeyPromise;
}

/**
 * The public verification key as a JWKS-ready JWK, tagged with the key id and
 * algorithm the worker matches against. Marked `use: 'sig'`.
 */
export async function getPublicJwk(): Promise<JWK> {
  const pem = requireEnv('MCP_JWT_PUBLIC_KEY');
  publicJwkPromise ??= (async () => {
    const key = await importSPKI(pem, MCP_ACCESS_TOKEN_ALG);
    const jwk = await exportJWK(key);
    return { ...jwk, kid: MCP_ACCESS_TOKEN_KID, alg: MCP_ACCESS_TOKEN_ALG, use: 'sig' };
  })();
  try {
    return await publicJwkPromise;
  } catch (error) {
    publicJwkPromise = null;
    throw error;
  }
}
