import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateRecordingPolicy } from '../recordingPolicy';
import { _clearAll } from '../cache';
import { _clearUsageCache } from '../usage';

const ACTIVE_SUB = {
  status: 'active' as const,
  tier: 'pro' as const,
  monthlyUnits: 10000,
  addonUnits: 0,
};

const HOBBY_SUB = {
  status: 'active' as const,
  tier: 'hobby' as const,
  monthlyUnits: 100,
  addonUnits: 0,
};

beforeEach(async () => {
  await _clearAll();
  _clearUsageCache();
});

function makeEnv(opts: {
  billing: string | null;
  doResponse?: { allowed: boolean; periodEnd?: number };
  doFails?: boolean;
}) {
  const mockFetch = opts.doFails
    ? vi.fn().mockRejectedValue(new Error('DO unreachable'))
    : vi.fn().mockResolvedValue(Response.json(opts.doResponse ?? { allowed: true }));

  return {
    API_KEYS: {
      get: vi.fn().mockResolvedValue(opts.billing),
    } as unknown as KVNamespace,
    USAGE_TRACKER: {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({ fetch: mockFetch }),
    } as unknown as DurableObjectNamespace,
    _doFetch: mockFetch,
  };
}

describe('evaluateRecordingPolicy', () => {
  it('returns record=true when billing active and usage allowed', async () => {
    const env = makeEnv({ billing: JSON.stringify(ACTIVE_SUB), doResponse: { allowed: true } });
    const { decision, usageCheck } = await evaluateRecordingPolicy(env, 'org-1', 1);
    expect(decision).toEqual({ record: true, reason: 'ok', tier: 'pro' });
    expect(usageCheck).toEqual({ status: 'allowed', tier: 'pro' });
  });

  it('short-circuits on suspended without calling usage DO', async () => {
    const env = makeEnv({ billing: JSON.stringify({ ...ACTIVE_SUB, status: 'suspended' }) });
    const { decision, usageCheck } = await evaluateRecordingPolicy(env, 'org-1', 1);
    expect(decision).toEqual({ record: false, reason: 'suspended' });
    expect(usageCheck).toEqual({ status: 'error', reason: 'billing_not_active' });
    expect(env._doFetch).not.toHaveBeenCalled();
  });

  it('short-circuits on canceled without calling usage DO', async () => {
    const env = makeEnv({ billing: JSON.stringify({ ...ACTIVE_SUB, status: 'canceled' }) });
    const { decision } = await evaluateRecordingPolicy(env, 'org-1', 1);
    expect(decision).toEqual({ record: false, reason: 'canceled' });
    expect(env._doFetch).not.toHaveBeenCalled();
  });

  it('short-circuits on not_found (no subscription in KV)', async () => {
    const env = makeEnv({ billing: null });
    const { decision } = await evaluateRecordingPolicy(env, 'org-1', 1);
    expect(decision).toEqual({ record: false, reason: 'no_subscription' });
    expect(env._doFetch).not.toHaveBeenCalled();
  });

  it('returns exceeded with tier + periodEnd when DO denies', async () => {
    const periodEnd = Date.now() + 86_400_000;
    const env = makeEnv({
      billing: JSON.stringify(HOBBY_SUB),
      doResponse: { allowed: false, periodEnd },
    });
    const { decision } = await evaluateRecordingPolicy(env, 'org-1', 1);
    expect(decision).toEqual({ record: false, reason: 'exceeded', tier: 'hobby', periodEnd });
  });

  it('returns internal_error when DO is unreachable', async () => {
    const env = makeEnv({ billing: JSON.stringify(ACTIVE_SUB), doFails: true });
    const { decision, usageCheck } = await evaluateRecordingPolicy(env, 'org-1', 1);
    expect(decision).toEqual({ record: false, reason: 'internal_error' });
    expect(usageCheck).toEqual({ status: 'error', reason: 'do_unreachable' });
  });

  it('returns internal_error when DO replies exceeded without periodEnd', async () => {
    const env = makeEnv({
      billing: JSON.stringify(ACTIVE_SUB),
      doResponse: { allowed: false },
    });
    const { decision } = await evaluateRecordingPolicy(env, 'org-1', 1);
    expect(decision).toEqual({ record: false, reason: 'internal_error' });
  });

  it('forwards count to the usage check', async () => {
    const env = makeEnv({ billing: JSON.stringify(ACTIVE_SUB), doResponse: { allowed: true } });
    await evaluateRecordingPolicy(env, 'org-1', 7);
    const req: Request = env._doFetch.mock.calls[0]![0];
    expect(await req.json()).toMatchObject({ count: 7 });
  });
});
