import { SignJWT, jwtVerify } from 'jose';
import { SESSION_TTL_MS } from '@trace-flow/mcp-core';

const SESSION_ALG = 'HS256';
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

interface SessionClaims {
  userId: string;
  protocolVersion: string;
}

/**
 * Stateless MCP session token. The worker stores nothing — the session "id" is
 * a signed JWT carrying the protocol version and the user it was minted for.
 * It's a protocol marker, not a credential (every call still presents an access
 * token), so an HMAC secret held only by the worker is sufficient.
 */
export async function mintSessionToken(claims: SessionClaims, secret: string): Promise<string> {
  return new SignJWT({ userId: claims.userId, protocolVersion: claims.protocolVersion })
    .setProtectedHeader({ alg: SESSION_ALG })
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setIssuedAt()
    .sign(new TextEncoder().encode(secret));
}

/** Verify a session token's signature/expiry. Returns null if invalid. */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: [SESSION_ALG],
    });
    if (typeof payload.userId !== 'string' || typeof payload.protocolVersion !== 'string') {
      return null;
    }
    return { userId: payload.userId, protocolVersion: payload.protocolVersion };
  } catch {
    return null;
  }
}
