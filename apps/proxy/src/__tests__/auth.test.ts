import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateApiKey, isAuthError, checkBillingStatus } from '../auth';
import { _clearAll } from '../cache';
import type { Context } from 'hono';

beforeEach(async () => {
  await _clearAll();
});

function createMockContext(
  headers: Record<string, string>,
  kvData: string | null,
): Context<{ Bindings: { API_KEYS: KVNamespace } }> {
  const mockGet = vi.fn().mockResolvedValue(kvData);
  const mockKV = {
    get: mockGet,
  } as unknown as KVNamespace;

  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
    env: {
      API_KEYS: mockKV,
    },
    json: (data: unknown, status: number) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  } as unknown as Context<{ Bindings: { API_KEYS: KVNamespace } }>;
}

describe('validateApiKey', () => {
  it('should return error when API key is missing', async () => {
    const context = createMockContext({}, null);

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
    const validKeyData = JSON.stringify({
      expiresAt: Date.now() + 100000,
      createdAt: Date.now(),
      orgId: 'org123',
    });

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
    }
    expect(context.env.API_KEYS.get).toHaveBeenCalledWith('valid-api-key');
  });

  it('should return error when API key is not found in KV', async () => {
    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'invalid-key',
      },
      null,
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

  it('should return error when API key is expired', async () => {
    const expiredKeyData = JSON.stringify({
      expiresAt: Date.now() - 10000,
      createdAt: Date.now() - 100000,
      orgId: 'org123',
    });

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
      expect(result.status).toBe(401);
      const body = await result.json();
      expect(body).toEqual({
        error: 'Invalid API key data',
        message: 'The API key data is corrupted',
      });
    }
  });

  it('should handle edge case where expiresAt equals current time', async () => {
    const currentTime = Date.now();
    const edgeCaseKeyData = JSON.stringify({
      expiresAt: currentTime,
      createdAt: currentTime - 1000,
      orgId: 'org789',
    });

    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'edge-case-key',
      },
      edgeCaseKeyData,
    );

    vi.spyOn(Date, 'now').mockReturnValue(currentTime);

    const result = await validateApiKey(context);

    // expiresAt === Date.now() means NOT expired (< not <=)
    expect(isAuthError(result)).toBe(false);

    vi.restoreAllMocks();
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

  it('returns error when KV data is not valid JSON', async () => {
    const env = { API_KEYS: createMockKV('not json') };
    const result = await checkBillingStatus(env, 'org-1');
    expect(result).toEqual({ status: 'error' });
  });

  it('returns error for unrecognized status', async () => {
    const env = { API_KEYS: createMockKV(JSON.stringify({ status: 'unknown_status' })) };
    const result = await checkBillingStatus(env, 'org-1');
    expect(result).toEqual({ status: 'error' });
  });
});
