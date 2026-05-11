import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAuth0JWT } from '../auth';
import type { Context } from 'hono';
import type { Logger } from '@trace-flow/logging';

vi.mock('jose', () => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(() => ({})),
}));

import { jwtVerify } from 'jose';

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: () => Promise.resolve(),
};

interface MockEnv {
  Bindings: { AUTH0_DOMAIN: string; AUTH0_CLIENT_ID: string };
  Variables: { userSub: string; logger: Logger };
}

function createMockContext(
  headers: Record<string, string>,
  env: { AUTH0_DOMAIN: string; AUTH0_CLIENT_ID: string },
): Context<MockEnv> {
  const vars: Record<string, unknown> = { logger: noopLogger };
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
    env,
    json: (data: unknown, status: number) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    set: (key: string, value: unknown) => {
      vars[key] = value;
    },
    get: (key: string) => vars[key],
  } as unknown as Context<MockEnv>;
}

describe('validateAuth0JWT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockEnv = {
    AUTH0_DOMAIN: 'dev-test.auth0.com',
    AUTH0_CLIENT_ID: 'test-client-id-123',
  };

  it('should return error when Authorization header is missing', async () => {
    const context = createMockContext({}, mockEnv);

    const result = await validateAuth0JWT(context);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Missing authorization',
      message: 'Please provide an Authorization: Bearer <token> header',
    });
  });

  it('should return error when Bearer token is missing', async () => {
    const context = createMockContext(
      {
        authorization: 'InvalidFormat',
      },
      mockEnv,
    );

    const result = await validateAuth0JWT(context);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Invalid authorization format',
      message: 'Authorization header must be in format: Bearer <token>',
    });
  });

  it('should return error when AUTH0_DOMAIN is missing', async () => {
    const context = createMockContext(
      {
        authorization: 'Bearer valid-token',
      },
      {
        AUTH0_DOMAIN: '',
        AUTH0_CLIENT_ID: 'test-client-id-123',
      },
    );

    const result = await validateAuth0JWT(context);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(500);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Server configuration error',
      message: 'Auth0 configuration is missing',
    });
  });

  it('should return error when AUTH0_CLIENT_ID is missing', async () => {
    const context = createMockContext(
      {
        authorization: 'Bearer valid-token',
      },
      {
        AUTH0_DOMAIN: 'dev-test.auth0.com',
        AUTH0_CLIENT_ID: '',
      },
    );

    const result = await validateAuth0JWT(context);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(500);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Server configuration error',
      message: 'Auth0 configuration is missing',
    });
  });

  it('should return error when JWT verification fails', async () => {
    const context = createMockContext(
      {
        authorization: 'Bearer invalid-token',
      },
      mockEnv,
    );

    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid signature'));

    const result = await validateAuth0JWT(context);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Invalid token',
      message: 'JWT verification failed',
    });
  });

  it('should return error when JWT is expired', async () => {
    const context = createMockContext(
      {
        authorization: 'Bearer expired-token',
      },
      mockEnv,
    );

    vi.mocked(jwtVerify).mockRejectedValue(new Error('Token expired'));

    const result = await validateAuth0JWT(context);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Token expired',
      message: 'The provided JWT has expired',
    });
  });

  it('should return null when JWT is valid (no custom role claim required)', async () => {
    const context = createMockContext(
      {
        authorization: 'Bearer valid-token',
      },
      mockEnv,
    );

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: 'https://dev-test.auth0.com/',
        aud: 'https://api.example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'auth0|user-1',
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as never,
    });

    const result = await validateAuth0JWT(context);

    expect(result).toBeNull();
    expect(context.get('userSub')).toBe('auth0|user-1');
    expect(jwtVerify).toHaveBeenCalledWith(
      'valid-token',
      expect.anything(),
      expect.objectContaining({
        issuer: 'https://dev-test.auth0.com/',
        audience: 'test-client-id-123',
      }),
    );
  });

  it('should return null when JWT includes neuron/roles but they are not required', async () => {
    const context = createMockContext(
      {
        authorization: 'Bearer valid-token',
      },
      mockEnv,
    );

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: 'https://dev-test.auth0.com/',
        aud: 'https://api.example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'auth0|user-2',
        'neuron/roles': ['User', 'Admin'],
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as never,
    });

    const result = await validateAuth0JWT(context);

    expect(result).toBeNull();
    expect(context.get('userSub')).toBe('auth0|user-2');
  });

  it('should properly strip Bearer prefix from token', async () => {
    const context = createMockContext(
      {
        authorization: 'Bearer my-jwt-token-123',
      },
      mockEnv,
    );

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: 'https://dev-test.auth0.com/',
        aud: 'https://api.example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'auth0|strip-test',
      },
      protectedHeader: { alg: 'RS256' },
      key: {} as never,
    });

    await validateAuth0JWT(context);

    expect(jwtVerify).toHaveBeenCalledWith(
      'my-jwt-token-123',
      expect.anything(),
      expect.anything(),
    );
  });
});
