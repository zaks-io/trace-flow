import { describe, it, expect, vi } from 'vitest';
import { validateApiKey } from '../auth';
import type { Context } from 'hono';

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

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Missing API key',
      message: 'Please provide an API key via X-Trace-Flow-Api-Key header',
    });
  });

  it('should accept API key from X-Trace-Flow-Api-Key header', async () => {
    const validKeyData = JSON.stringify({
      expiresAt: Date.now() + 100000,
      createdAt: Date.now(),
    });

    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'valid-api-key',
      },
      validKeyData,
    );

    const result = await validateApiKey(context);

    expect(result).toBeNull();
    // eslint-disable-next-line @typescript-eslint/unbound-method
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

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Invalid API key',
      message: 'The provided API key is not valid',
    });
  });

  it('should return error when API key is expired', async () => {
    const expiredKeyData = JSON.stringify({
      expiresAt: Date.now() - 10000,
      createdAt: Date.now() - 100000,
    });

    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'expired-key',
      },
      expiredKeyData,
    );

    const result = await validateApiKey(context);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Expired API key',
      message: 'The provided API key has expired',
    });
  });

  it('should return error when API key data is corrupted', async () => {
    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'corrupt-key',
      },
      'not valid json',
    );

    const result = await validateApiKey(context);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);

    const body = await result?.json();
    expect(body).toEqual({
      error: 'Invalid API key data',
      message: 'The API key data is corrupted',
    });
  });

  it('should return null for valid API key', async () => {
    const validKeyData = JSON.stringify({
      expiresAt: Date.now() + 100000,
      createdAt: Date.now(),
    });

    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'valid-key',
      },
      validKeyData,
    );

    const result = await validateApiKey(context);

    expect(result).toBeNull();
  });

  it('should handle edge case where expiresAt equals current time', async () => {
    const currentTime = Date.now();
    const edgeCaseKeyData = JSON.stringify({
      expiresAt: currentTime,
      createdAt: currentTime - 1000,
    });

    const context = createMockContext(
      {
        'x-trace-flow-api-key': 'edge-case-key',
      },
      edgeCaseKeyData,
    );

    vi.spyOn(Date, 'now').mockReturnValue(currentTime);

    const result = await validateApiKey(context);

    expect(result).toBeNull();

    vi.restoreAllMocks();
  });
});
