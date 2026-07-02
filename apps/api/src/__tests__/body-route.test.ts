import { describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
  BODY_ACCESS_TOKEN_AUDIENCE,
  BODY_ACCESS_TOKEN_ISSUER,
  BODY_ACCESS_TOKEN_SCOPE,
  buildStoredBodyKey,
} from '@trace-flow/types';
import { encryptStoredBodyPayload } from '@trace-flow/utils';
import { apiApp } from '../index';

const SECRET = 'test-body-access-secret';
const ROOT_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

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
    BODY_ACCESS_JWT_SECRET: SECRET,
    BODY_ENCRYPTION_ROOT_KEY: ROOT_KEY,
    BODY_ENCRYPTION_KEY_ID: 'v1',
    STORAGE: { get: storageGet },
    API_KEYS: {
      get: vi.fn().mockResolvedValue({ tier: 'hobby' }),
    },
    BODIES_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function storedObject(body: string, overrides: Partial<R2ObjectBody> = {}) {
  return {
    text: vi.fn().mockResolvedValue(body),
    uploaded: new Date(),
    customMetadata: { orgId: 'org_123' },
    ...overrides,
  } as unknown as R2ObjectBody;
}

async function encryptedStoredObject(requestId: string, payload: unknown, orgId = 'org_123') {
  const encrypted = await encryptStoredBodyPayload(JSON.stringify(payload), {
    rootKeyBase64: ROOT_KEY,
    orgId,
    objectKey: buildStoredBodyKey(requestId),
  });

  return storedObject(JSON.stringify(encrypted), {
    customMetadata: { orgId },
  });
}

describe('GET /bodies/:requestId', () => {
  it('rejects missing authorization', async () => {
    const storageGet = vi.fn();

    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123'),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(401);
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('returns stored bodies for a valid request-scoped token', async () => {
    const storageGet = vi.fn().mockResolvedValue(
      storedObject(
        JSON.stringify({
          requestBody: '{"prompt":"hi"}',
          responseBody: '{"output":"hello"}',
        }),
      ),
    );
    const token = await signBodyToken();

    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
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

  it('decrypts encrypted stored bodies for a valid request-scoped token', async () => {
    const storageGet = vi.fn().mockResolvedValue(
      await encryptedStoredObject('req_123', {
        requestBody: '{"prompt":"encrypted"}',
        responseBody: '{"output":"decrypted"}',
      }),
    );
    const token = await signBodyToken();

    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      requestBody: '{"prompt":"encrypted"}',
      responseBody: '{"output":"decrypted"}',
    });
  });

  it('rejects bearer tokens that are not body access tokens', async () => {
    const storageGet = vi.fn();

    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
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
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden', message: 'Request mismatch' });
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('returns forbidden when the Body Object org does not match the token org', async () => {
    const storageGet = vi.fn().mockResolvedValue(
      storedObject(
        JSON.stringify({
          requestBody: '{"prompt":"hi"}',
          responseBody: '{"output":"hello"}',
        }),
        { customMetadata: { orgId: 'org_other' } },
      ),
    );
    const token = await signBodyToken();

    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Forbidden',
      message: 'Organization mismatch',
    });
  });

  it('returns not found when the Body Object is missing', async () => {
    const storageGet = vi.fn().mockResolvedValue(null);
    const token = await signBodyToken();

    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Bodies not found' });
  });

  it('returns expired when the Body Object is outside the visibility window', async () => {
    const storageGet = vi.fn().mockResolvedValue(
      storedObject(
        JSON.stringify({
          requestBody: '{"prompt":"old"}',
          responseBody: '{"output":"old"}',
        }),
        { uploaded: new Date('2026-01-01T00:00:00.000Z') },
      ),
    );
    const token = await signBodyToken();

    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toEqual({
      error: 'Bodies expired under current retention policy',
    });
  });

  it('returns not found when the Body Object payload is malformed', async () => {
    const storageGet = vi.fn().mockResolvedValue(storedObject('not json'));
    const token = await signBodyToken();

    const res = await apiApp.fetch(
      new Request('https://raw.trace-flow.dev/bodies/req_123', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env(storageGet),
      executionCtx(),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Bodies not found' });
  });
});
