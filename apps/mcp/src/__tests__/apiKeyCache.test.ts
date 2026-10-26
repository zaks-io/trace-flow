import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@trace-flow/utils';
import { authorizeMcpApiKey, MCP_AUTHORIZATION_TTL_MS } from '../apiKeyAuth';

const CONFIG = { connectBaseUrl: 'https://connect.test', sharedSecret: 'test-backend-secret' };
const allowed = { authorized: true, userId: 'u-cache' } as const;

describe('positive MCP authorization cache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('misses for distinct keys and hits until the fixed TTL expires', async () => {
    const key = crypto.randomUUID();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(allowed));
    expect(await authorizeMcpApiKey(key, CONFIG)).toEqual(allowed);
    clock.mockReturnValue(now + MCP_AUTHORIZATION_TTL_MS - 1);
    expect(await authorizeMcpApiKey(key, CONFIG)).toEqual(allowed);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + MCP_AUTHORIZATION_TTL_MS);
    fetchSpy.mockResolvedValue(Response.json({ authorized: false, reason: 'invalid' }));
    expect(await authorizeMcpApiKey(key, CONFIG)).toEqual({ authorized: false, reason: 'invalid' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockResolvedValue(Response.json(allowed));
    await authorizeMcpApiKey(crypto.randomUUID(), CONFIG);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it.each(['invalid', 'expired', 'forbidden'] as const)(
    'never caches %s results',
    async (reason) => {
      const key = crypto.randomUUID();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json({ authorized: false, reason }));
      await authorizeMcpApiKey(key, CONFIG);
      fetchSpy.mockResolvedValue(Response.json(allowed));
      expect(await authorizeMcpApiKey(key, CONFIG)).toEqual(allowed);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it.each([500, 200])(
    'does not cache backend failures or malformed responses, status %s',
    async (status) => {
      const key = crypto.randomUUID();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({}, { status }));
      await expect(authorizeMcpApiKey(key, CONFIG)).rejects.toThrow();
      fetchSpy.mockResolvedValue(Response.json(allowed));
      expect(await authorizeMcpApiKey(key, CONFIG)).toEqual(allowed);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it('includes backend latency in the staleness bound', async () => {
    const key = crypto.randomUUID();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      clock.mockReturnValue(now + 5_000);
      return Response.json(allowed);
    });
    await authorizeMcpApiKey(key, CONFIG);
    clock.mockReturnValue(now + MCP_AUTHORIZATION_TTL_MS);
    await authorizeMcpApiKey(key, CONFIG);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('cannot share authorization across backend URLs or secret rotation', async () => {
    const key = crypto.randomUUID();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(allowed));
    await authorizeMcpApiKey(key, CONFIG);
    await authorizeMcpApiKey(key, { ...CONFIG, connectBaseUrl: 'https://other.test' });
    await authorizeMcpApiKey(key, { ...CONFIG, sharedSecret: 'rotated-test-secret' });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('stores only the SHA-256 key, user identity, backend digest and expiry', async () => {
    const key = crypto.randomUUID();
    const digest = await sha256Hex(key);
    const cacheWrites = vi.spyOn(Map.prototype, 'set');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ ...allowed, orgId: 'do-not-cache' }),
    );
    await authorizeMcpApiKey(key, CONFIG);
    const writes = cacheWrites.mock.calls.filter(([cacheKey]) => cacheKey === digest);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([
      digest,
      {
        userId: allowed.userId,
        backend: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(cacheWrites.mock.calls)).not.toContain(key);
    expect(JSON.stringify(writes)).not.toContain(CONFIG.sharedSecret);
    const result = await authorizeMcpApiKey(key, CONFIG);
    if (result.authorized) result.userId = 'mutated';
    expect(await authorizeMcpApiKey(key, CONFIG)).toEqual(allowed);
  });
});
