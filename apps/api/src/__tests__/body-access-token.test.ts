import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  BODY_ACCESS_TOKEN_AUDIENCE,
  BODY_ACCESS_TOKEN_ISSUER,
  BODY_ACCESS_TOKEN_SCOPE,
} from '@trace-flow/types';
import { readBearerToken, verifyBodyAccessToken } from '../body-access-token';

const SECRET = 'test-body-access-secret';

async function signBodyToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: 'auth0|user-1',
    orgId: 'org_123',
    requestId: 'req_123',
    scope: BODY_ACCESS_TOKEN_SCOPE,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(String(overrides.iss ?? BODY_ACCESS_TOKEN_ISSUER))
    .setAudience(String(overrides.aud ?? BODY_ACCESS_TOKEN_AUDIENCE))
    .setIssuedAt(now)
    .setExpirationTime(Number(overrides.exp ?? now + 60))
    .sign(new TextEncoder().encode(SECRET));
}

describe('body access tokens', () => {
  it('reads bearer tokens', () => {
    expect(readBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(readBearerToken('Bearer   abc.def  ')).toBe('abc.def');
    expect(readBearerToken('Basic abc.def')).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
  });

  it('verifies request-scoped body token claims', async () => {
    const token = await signBodyToken();

    await expect(verifyBodyAccessToken(token, SECRET)).resolves.toEqual({
      sub: 'auth0|user-1',
      orgId: 'org_123',
      requestId: 'req_123',
      scope: BODY_ACCESS_TOKEN_SCOPE,
    });
  });

  it('rejects wrong audience', async () => {
    const token = await signBodyToken({ aud: 'trace-flow:api' });

    await expect(verifyBodyAccessToken(token, SECRET)).resolves.toBeNull();
  });

  it('rejects wrong scope', async () => {
    const token = await signBodyToken({ scope: 'api:read' });

    await expect(verifyBodyAccessToken(token, SECRET)).resolves.toBeNull();
  });

  it('rejects expired tokens', async () => {
    const token = await signBodyToken({ exp: Math.floor(Date.now() / 1000) - 1 });

    await expect(verifyBodyAccessToken(token, SECRET)).resolves.toBeNull();
  });
});
