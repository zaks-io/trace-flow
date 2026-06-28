import { describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
  BODY_ACCESS_TOKEN_AUDIENCE,
  BODY_ACCESS_TOKEN_ISSUER,
  BODY_ACCESS_TOKEN_SCOPE,
} from '@trace-flow/types';
import { apiApp } from '../index';

const SECRET = 'test-body-access-secret';

function executionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

async function signBodyToken(requestId = 'req_123') {
  return new SignJWT({
    sub: 'auth0|user-1',
    orgId: 'org_123',
    requestId,
    scope: BODY_ACCESS_TOKEN_SCOPE,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(BODY_ACCESS_TOKEN_ISSUER)
    .setAudience(BODY_ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(new TextEncoder().encode(SECRET));
}

function env(storageGet = vi.fn()) {
  return {
    SENTRY_ENVIRONMENT: 'development',
    TINYBIRD_API_URL: 'https://api.tinybird.test',
    TINYBIRD_ADMIN_TOKEN: 'tb-token',
    BODY_ACCESS_JWT_SECRET: SECRET,
    STORAGE: { get: storageGet },
    API_KEYS: {
      get: vi.fn().mockResolvedValue({ tier: 'hobby' }),
    },
    BODIES_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    PIPES_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

describe('GET /bodies/:requestId', () => {
  it('returns stored bodies for a valid request-scoped token', async () => {
    const storageGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          requestBody: '{"prompt":"hi"}',
          responseBody: '{"output":"hello"}',
        }),
      ),
      uploaded: new Date(),
      customMetadata: { orgId: 'org_123' },
    });
    const token = await signBodyToken();

    const res = await apiApp.fetch(
      new Request('https://api.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Vary')).toContain('Authorization');
    await expect(res.json()).resolves.toEqual({
      requestBody: '{"prompt":"hi"}',
      responseBody: '{"output":"hello"}',
    });
    expect(storageGet).toHaveBeenCalledWith('bodies/req_123');
  });

  it('rejects bearer tokens that are not body access tokens', async () => {
    const storageGet = vi.fn();

    const res = await apiApp.fetch(
      new Request('https://api.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: 'Bearer auth0-access-token' },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(401);
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('rejects body tokens minted for a different request ID', async () => {
    const storageGet = vi.fn();
    const token = await signBodyToken('req_other');

    const res = await apiApp.fetch(
      new Request('https://api.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden', message: 'Request mismatch' });
    expect(storageGet).not.toHaveBeenCalled();
  });
});
