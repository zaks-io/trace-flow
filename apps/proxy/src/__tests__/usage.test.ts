import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkUsage, _clearUsageCache } from '../usage';

beforeEach(() => {
  _clearUsageCache();
});

function createMockEnv(
  kvData: string | null,
  doResponse: { allowed: boolean; periodEnd?: number },
) {
  const mockFetch = vi.fn().mockResolvedValue(Response.json(doResponse));
  const mockStub = { fetch: mockFetch };
  const mockIdFromName = vi.fn().mockReturnValue('do-id-123');
  const mockGet = vi.fn().mockReturnValue(mockStub);

  return {
    env: {
      API_KEYS: {
        get: vi.fn().mockResolvedValue(kvData),
      } as unknown as KVNamespace,
      USAGE_TRACKER: {
        idFromName: mockIdFromName,
        get: mockGet,
      } as unknown as DurableObjectNamespace,
    },
    mockFetch,
    mockIdFromName,
  };
}

describe('checkUsage', () => {
  it('returns error when no subscription config in KV', async () => {
    const { env } = createMockEnv(null, { allowed: false });
    const result = await checkUsage(env, 'org-1', 1);
    expect(result).toEqual({ status: 'error', reason: 'no_subscription_config' });
  });

  it('returns allowed with tier when DO responds allowed: true', async () => {
    const kvData = JSON.stringify({
      tier: 'pro',
      monthlyUnits: 10000,
      addonUnits: 0,
    });
    const { env } = createMockEnv(kvData, { allowed: true });
    const result = await checkUsage(env, 'org-1', 1);
    expect(result).toEqual({ status: 'allowed', tier: 'pro' });
  });

  it('returns exceeded with tier and periodEnd when DO responds allowed: false', async () => {
    const periodEnd = Date.now() + 86400000;
    const kvData = JSON.stringify({
      tier: 'hobby',
      monthlyUnits: 100,
      addonUnits: 0,
    });
    const { env } = createMockEnv(kvData, { allowed: false, periodEnd });
    const result = await checkUsage(env, 'org-1', 1);
    expect(result).toEqual({ status: 'exceeded', tier: 'hobby', periodEnd });
  });

  it('returns error when DO responds exceeded without periodEnd', async () => {
    const kvData = JSON.stringify({
      tier: 'hobby',
      monthlyUnits: 100,
      addonUnits: 0,
    });
    const { env } = createMockEnv(kvData, { allowed: false });
    const result = await checkUsage(env, 'org-1', 1);
    expect(result).toEqual({ status: 'error', reason: 'do_missing_period_end' });
  });

  it('passes correct subscription config and count to DO', async () => {
    const kvData = JSON.stringify({
      tier: 'pro',
      monthlyUnits: 5000,
      addonUnits: 200,
    });
    const { env, mockFetch } = createMockEnv(kvData, { allowed: true });
    await checkUsage(env, 'org-1', 3);

    expect(mockFetch).toHaveBeenCalledOnce();
    const request: Request = mockFetch.mock.calls[0]![0];
    const body = await request.json();
    expect(body).toEqual({
      count: 3,
      orgId: 'org-1',
      subscriptionConfig: {
        tier: 'pro',
        monthlyUnits: 5000,
        addonUnits: 200,
      },
    });
  });

  it('uses idFromName(orgId) to get DO stub', async () => {
    const kvData = JSON.stringify({
      tier: 'hobby',
      monthlyUnits: 100,
      addonUnits: 0,
    });
    const { env, mockIdFromName } = createMockEnv(kvData, { allowed: true });
    await checkUsage(env, 'org-abc', 1);

    expect(mockIdFromName).toHaveBeenCalledWith('org-abc');
  });

  it('returns error when DO fetch fails', async () => {
    const kvData = JSON.stringify({ tier: 'pro', monthlyUnits: 10000, addonUnits: 0 });
    const mockStub = { fetch: vi.fn().mockRejectedValue(new Error('DO unreachable')) };
    const env = {
      API_KEYS: { get: vi.fn().mockResolvedValue(kvData) } as unknown as KVNamespace,
      USAGE_TRACKER: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue(mockStub),
      } as unknown as DurableObjectNamespace,
    };
    const result = await checkUsage(env, 'org-1', 1);
    expect(result).toEqual({ status: 'error', reason: 'do_unreachable' });
  });

  it('skips KV read when prefetched subscription is provided', async () => {
    const prefetched = {
      tier: 'pro' as const,
      monthlyUnits: 10000,
      addonUnits: 0,
      status: 'active' as const,
    };
    const { env } = createMockEnv(null, { allowed: true });
    const result = await checkUsage(env, 'org-1', 1, prefetched);
    expect(result).toEqual({ status: 'allowed', tier: 'pro' });
    // KV should not have been called
    expect(env.API_KEYS.get).not.toHaveBeenCalled();
  });

  it('returns error when KV data is not valid JSON', async () => {
    const env = {
      API_KEYS: { get: vi.fn().mockResolvedValue('not json') } as unknown as KVNamespace,
      USAGE_TRACKER: {} as unknown as DurableObjectNamespace,
    };
    const result = await checkUsage(env, 'org-1', 1);
    expect(result).toEqual({ status: 'error', reason: 'invalid_subscription_config' });
  });

  it('caches exceeded result — second call skips DO', async () => {
    const periodEnd = Date.now() + 86400000;
    const kvData = JSON.stringify({ tier: 'hobby', monthlyUnits: 100, addonUnits: 0 });
    const { env, mockFetch } = createMockEnv(kvData, { allowed: false, periodEnd });

    await checkUsage(env, 'org-cache-exceeded', 1);
    expect(mockFetch).toHaveBeenCalledOnce();

    // Second call should return cached exceeded without hitting DO
    const result = await checkUsage(env, 'org-cache-exceeded', 1);
    expect(result).toEqual({ status: 'exceeded', tier: 'hobby', periodEnd });
    expect(mockFetch).toHaveBeenCalledOnce(); // Still 1 — DO was not called again
  });

  it('does NOT cache error results — second call retries DO', async () => {
    const kvData = JSON.stringify({ tier: 'pro', monthlyUnits: 10000, addonUnits: 0 });
    const mockStub = { fetch: vi.fn().mockRejectedValue(new Error('DO unreachable')) };
    const env = {
      API_KEYS: { get: vi.fn().mockResolvedValue(kvData) } as unknown as KVNamespace,
      USAGE_TRACKER: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue(mockStub),
      } as unknown as DurableObjectNamespace,
    };

    const first = await checkUsage(env, 'org-cache-error', 1);
    expect(first).toEqual({ status: 'error', reason: 'do_unreachable' });
    expect(mockStub.fetch).toHaveBeenCalledOnce();

    // Second call should retry the DO, not return cached error
    await checkUsage(env, 'org-cache-error', 1);
    expect(mockStub.fetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache allowed results — every call hits DO', async () => {
    const kvData = JSON.stringify({ tier: 'pro', monthlyUnits: 10000, addonUnits: 0 });
    const { env, mockFetch } = createMockEnv(kvData, { allowed: true });

    await checkUsage(env, 'org-cache-allowed', 1);
    await checkUsage(env, 'org-cache-allowed', 1);
    await checkUsage(env, 'org-cache-allowed', 1);

    // DO must be called every time to increment the counter
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
