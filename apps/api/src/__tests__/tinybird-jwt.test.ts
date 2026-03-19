import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JWTPayload } from 'jose';
import { verifyTinybirdJWT, extractCacheParams, type TinybirdJWTPayload } from '../tinybird-jwt';

vi.mock('jose', () => ({
  jwtVerify: vi.fn(),
}));

import { jwtVerify } from 'jose';

describe('verifyTinybirdJWT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should verify a valid token and return payload', async () => {
    const mockPayload: TinybirdJWTPayload = {
      workspace_id: 'ws_123',
      name: 'test_token',
      scopes: [
        {
          type: 'PIPES:READ',
          resource: 'traces_list',
          fixed_params: { api_keys: 'key1,key2', retention_days: 7 },
        },
      ],
    };

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: mockPayload as unknown as JWTPayload,
      protectedHeader: { alg: 'HS256' },
      key: {} as never,
    });

    const result = await verifyTinybirdJWT('valid-token', 'admin-secret');

    expect(result).toEqual(mockPayload);
    expect(jwtVerify).toHaveBeenCalledWith('valid-token', expect.any(Uint8Array), {
      algorithms: ['HS256'],
    });
  });

  it('should reject an invalid token', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid signature'));

    await expect(verifyTinybirdJWT('bad-token', 'admin-secret')).rejects.toThrow(
      'Invalid signature',
    );
  });

  it('should reject an expired token', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('"exp" claim timestamp check failed'));

    await expect(verifyTinybirdJWT('expired-token', 'admin-secret')).rejects.toThrow('exp');
  });
});

describe('extractCacheParams', () => {
  it('should extract api_keys and retention_days from JWT payload', () => {
    const payload: TinybirdJWTPayload = {
      workspace_id: 'ws_123',
      name: 'test_token',
      scopes: [
        {
          type: 'PIPES:READ',
          resource: 'traces_list',
          fixed_params: { api_keys: 'key1,key2', retention_days: 30 },
        },
      ],
    };

    const result = extractCacheParams(payload);

    expect(result).toEqual({
      apiKeys: 'key1,key2',
      retentionDays: 30,
    });
  });

  it('should default api_keys to empty string when missing', () => {
    const payload: TinybirdJWTPayload = {
      workspace_id: 'ws_123',
      name: 'test_token',
      scopes: [{ type: 'PIPES:READ', resource: 'traces_list', fixed_params: {} }],
    };

    const result = extractCacheParams(payload);
    expect(result.apiKeys).toBe('');
  });

  it('should default retention_days to 0 when missing', () => {
    const payload: TinybirdJWTPayload = {
      workspace_id: 'ws_123',
      name: 'test_token',
      scopes: [{ type: 'PIPES:READ', resource: 'traces_list' }],
    };

    const result = extractCacheParams(payload);
    expect(result.retentionDays).toBe(0);
  });

  it('should throw when scopes is empty', () => {
    const payload: TinybirdJWTPayload = {
      workspace_id: 'ws_123',
      name: 'test_token',
      scopes: [],
    };

    expect(() => extractCacheParams(payload)).toThrow('JWT missing scopes');
  });

  it('should throw when scopes is undefined', () => {
    const payload = {
      workspace_id: 'ws_123',
      name: 'test_token',
    } as unknown as TinybirdJWTPayload;

    expect(() => extractCacheParams(payload)).toThrow('JWT missing scopes');
  });
});
