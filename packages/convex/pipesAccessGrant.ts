import { jwtVerify, SignJWT } from 'jose';

const ISSUER = 'trace-flow-convex';
const AUDIENCE = 'trace-flow-pipes-api';

export interface PipesAccessGrant {
  userId: string;
  orgId: string;
  pipe?: string;
  expiresAt: number;
}

export async function signPipesAccessGrant(
  grant: Omit<PipesAccessGrant, 'expiresAt'>,
  secret: string,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = await new SignJWT({ orgId: grant.orgId, pipe: grant.pipe })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(grant.userId)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(secret));
  return { token, expiresAt };
}

export async function verifyPipesAccessGrant(
  token: string,
  secret: string,
): Promise<PipesAccessGrant | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.orgId !== 'string' ||
      typeof payload.exp !== 'number' ||
      (payload.pipe !== undefined && typeof payload.pipe !== 'string')
    ) {
      return null;
    }
    return {
      userId: payload.sub,
      orgId: payload.orgId,
      pipe: payload.pipe,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}
