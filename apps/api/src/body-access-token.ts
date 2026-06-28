import { jwtVerify } from 'jose';
import {
  BODY_ACCESS_TOKEN_AUDIENCE,
  BODY_ACCESS_TOKEN_ISSUER,
  BODY_ACCESS_TOKEN_SCOPE,
  type BodyAccessTokenClaims,
} from '@trace-flow/types';

export type VerifiedBodyAccessToken = BodyAccessTokenClaims;

export function readBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function isBodyAccessClaims(value: unknown): value is BodyAccessTokenClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Partial<BodyAccessTokenClaims>;
  return (
    typeof payload.sub === 'string' &&
    typeof payload.orgId === 'string' &&
    typeof payload.requestId === 'string' &&
    payload.scope === BODY_ACCESS_TOKEN_SCOPE
  );
}

export async function verifyBodyAccessToken(
  token: string,
  secret: string,
): Promise<VerifiedBodyAccessToken | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: BODY_ACCESS_TOKEN_ISSUER,
      audience: BODY_ACCESS_TOKEN_AUDIENCE,
    });

    if (!isBodyAccessClaims(payload)) return null;
    return {
      sub: payload.sub,
      orgId: payload.orgId,
      requestId: payload.requestId,
      scope: payload.scope,
    };
  } catch {
    return null;
  }
}
