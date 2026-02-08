import { describe, it, expect, vi } from 'vitest';
import { checkUsage } from '../usage';

function createMockEnv(kvData: string | null, doResponse: { allowed: boolean }) {
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
  it('throws when no subscription config in KV', async () => {
    const { env } = createMockEnv(null, { allowed: false });
    await expect(checkUsage(env, 'org-1', 1)).rejects.toThrow(
      'No subscription config found in KV for org: org-1',
    );
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

  it('returns exceeded with tier when DO responds allowed: false', async () => {
    const kvData = JSON.stringify({
      tier: 'hobby',
      monthlyUnits: 100,
      addonUnits: 0,
    });
    const { env } = createMockEnv(kvData, { allowed: false });
    const result = await checkUsage(env, 'org-1', 1);
    expect(result).toEqual({ status: 'exceeded', tier: 'hobby' });
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
});
