import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateApiKey, isAuthError, checkBillingStatus } from '../auth';
import { _clearAll } from '../cache';
import { analyticsKeyId } from '@trace-flow/utils';
import type { Context } from 'hono';

beforeEach(async () => {
  await _clearAll();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createMockContext(
  headers: Record<string, string>,
  authorization: object | string,
): Context<{
  Bindings: {
    API_KEYS: KVNamespace;
    CONVEX_SITE_URL: string;
    USAGE_SYNC_SECRET: string;
  };
}> {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            typeof authorization === 'string' ? authorization : JSON.stringify(authorization),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
  );

  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
    env: {
      API_KEYS: { get: vi.fn() } as unknown as KVNamespace,
      CONVEX_SITE_URL: 'https://convex.test',
      USAGE_SYNC_SECRET: 'worker-secret',
    },
    json: (data: unknown, status: number) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  } as unknown as Context<{
    Bindings: {
      API_KEYS: KVNamespace;
      CONVEX_SITE_URL: string;
      USAGE_SYNC_SECRET: string;
    };
  }>;
}

describe('validateApiKey', () => {
  it('should return error when API key is missing', async () => {
    const context = createMockContext({}, { authorized: false, reason: 'invalid' });

    const result = await validateApiKey(context);

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
      const body = await result.json();
      expect(body).toEqual({
        error: 'Missing API key',
        message: 'Please provide an API key via X-Trace-Flow-Api-Key header',
      });
    }
  });

  it('should return ApiKeyData for valid API key from X-Trace-Flow-Api-Key header', async () => {
    const validKeyData = {
      authorized: true,
      expiresAt: Date.now() + 100000,
      createdAt: Date.now(),
      orgId: 'org123',
    };

    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'valid-api-key',
      },
      validKeyData,
    );

    const result = await validateApiKey(context);

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect(result.orgId).toBe('org123');
      expect(result.analyticsKeyId).toBe(await analyticsKeyId('valid-api-key'));
      expect(JSON.stringify(result)).not.toContain('valid-api-key');
    }
    expect(fetch).toHaveBeenCalledWith(
      'https://convex.test/worker/authorize-api-key',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ key: 'valid-api-key' }),
      }),
    );
  });

  it('should return error when API key is not found in current state', async () => {
    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'invalid-key',
      },
      { authorized: false, reason: 'invalid' },
    );

    const result = await validateApiKey(context);

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
      const body = await result.json();
      expect(body).toEqual({
        error: 'Invalid API key',
        message: 'The provided API key is not valid',
      });
    }
  });

  it('should return error when API key is already expired', async () => {
    const expiredKeyData = {
      authorized: false,
      reason: 'expired',
      expiresAt: Date.now() - 10000,
      createdAt: Date.now() - 100000,
      orgId: 'org123',
    };

    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'expired-key',
      },
      expiredKeyData,
    );

    const result = await validateApiKey(context);

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
      const body = await result.json();
      expect(body).toEqual({
        error: 'Expired API key',
        message: 'The provided API key has expired',
      });
    }
  });

  it('should evict and reject key that expires after being cached', async () => {
    const expiresAt = Date.now() + 100;
    const keyData = {
      authorized: true,
      expiresAt,
      createdAt: Date.now(),
      orgId: 'org123',
    };

    const context = createMockContext({ 'x-trace-flow-api-key': 'about-to-expire' }, keyData);

    // First call: key is valid.
    const first = await validateApiKey(context);
    expect(isAuthError(first)).toBe(false);

    // Simulate time passing past expiry
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);

    // Second call gets a fresh control-plane decision and rechecks expiry locally.
    const second = await validateApiKey(context);
    expect(isAuthError(second)).toBe(true);
    if (isAuthError(second)) {
      expect(second.status).toBe(401);
      const body = await second.json();
      expect(body).toEqual({
        error: 'Expired API key',
        message: 'The provided API key has expired',
      });
    }
  });

  it('should return error when API key data is corrupted', async () => {
    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'corrupt-key',
      },
      'not valid json',
    );

    const result = await validateApiKey(context);

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(503);
      const body = await result.json();
      expect(body).toEqual({
        error: 'Authentication unavailable',
        message: 'Retry the request',
      });
    }
  });

  it('should handle edge case where expiresAt equals current time', async () => {
    const currentTime = Date.now();
    const edgeCaseKeyData = {
      authorized: true,
      expiresAt: currentTime,
      createdAt: currentTime - 1000,
      orgId: 'org789',
    };

    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'edge-case-key',
      },
      edgeCaseKeyData,
    );

    vi.spyOn(Date, 'now').mockReturnValue(currentTime);

    const result = await validateApiKey(context);

    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) expect(result.status).toBe(401);
  });

  it('rejects a revoked key immediately after a successful authorization', async () => {
    const context = createMockContext(
      { 'x-trace-flow-api-key': 'revoked-after-warmup' },
      { authorized: true, expiresAt: Date.now() + 60_000, createdAt: 1, orgId: 'org123' },
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorized: true,
            expiresAt: Date.now() + 60_000,
            createdAt: 1,
            orgId: 'org123',
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authorized: false, reason: 'invalid' })),
      );

    expect(isAuthError(await validateApiKey(context))).toBe(false);
    const revoked = await validateApiKey(context);
    expect(isAuthError(revoked)).toBe(true);
    if (isAuthError(revoked)) expect(revoked.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('checkBillingStatus', () => {
  function createMockKV(data: string | null) {
    return { get: vi.fn().mockResolvedValue(data) } as unknown as KVNamespace;
  }

  it('returns active with subscription data', async () => {
    const sub = { status: 'active', tier: 'pro', monthlyUnits: 100000, addonUnits: 0 };
    const env = { API_KEYS: createMockKV(JSON.stringify(sub)) };
    const result = await checkBillingStatus(env, 'org-1');
    expect(result).toEqual({ status: 'active', subscription: sub });
  });

  it('returns grace with subscription data', async () => {
    const sub = { status: 'grace', tier: 'pro', monthlyUnits: 100000, addonUnits: 0 };
    const env = { API_KEYS: createMockKV(JSON.stringify(sub)) };
    const result = await checkBillingStatus(env, 'org-1');
    expect(result).toEqual({ status: 'grace', subscription: sub });
  });

  it('returns suspended with subscription data', async () => {
    const sub = { status: 'suspended', tier: 'pro', monthlyUnits: 100000, addonUnits: 0 };
    const env = { API_KEYS: createMockKV(JSON.stringify(sub)) };
    const result = await checkBillingStatus(env, 'org-1');
    expect(result).toEqual({ status: 'suspended', subscription: sub });
  });

  it('returns canceled with subscription data', async () => {
    const sub = { status: 'canceled', tier: 'pro', monthlyUnits: 100000, addonUnits: 0 };
    const env = { API_KEYS: createMockKV(JSON.stringify(sub)) };
    const result = await checkBillingStatus(env, 'org-1');
    expect(result).toEqual({ status: 'canceled', subscription: sub });
  });

  it('returns not_found when KV has no entry', async () => {
    const env = { API_KEYS: createMockKV(null) };
    const result = await checkBillingStatus(env, 'org-1');
    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns not_found when KV data is not valid JSON', async () => {
    const env = { API_KEYS: createMockKV('not json') };
    const result = await checkBillingStatus(env, 'org-1');
    // Corrupt data resolves to not_found inside the cache fetcher (not cached as error)
    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns not_found for unrecognized status', async () => {
    const env = { API_KEYS: createMockKV(JSON.stringify({ status: 'unknown_status' })) };
    const result = await checkBillingStatus(env, 'org-1');
    expect(result).toEqual({ status: 'not_found' });
  });
});
