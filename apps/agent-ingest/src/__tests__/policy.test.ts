import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { createWorkerLogger } from '@trace-flow/logging';
import {
  __resetPolicyCache,
  checkCompatibility,
  getCompatibilityPolicy,
  type CompatibilityPolicy,
} from '../policy';

const CONVEX = 'https://convex.test';
const env = { CONVEX_SITE_URL: CONVEX, AGENT_INGEST_SHARED_SECRET: 'shared-secret' };

const logger = createWorkerLogger({
  service: 'agent-ingest',
  request: new Request('https://ingest.test/v1/ingest', { method: 'POST' }),
});

const policy: CompatibilityPolicy = {
  minDesktopVersion: '1.0.0',
  minParserVersion: '1.0.0',
  denylistedVersions: ['9.9.9'],
  updatedAt: 1_700_000_000_000,
};

function interceptPolicy(status: number, body: unknown): void {
  fetchMock
    .get(CONVEX)
    .intercept({ path: '/agent-ingest/compatibility-policy', method: 'GET' })
    .reply(status, typeof body === 'string' ? body : JSON.stringify(body));
}

describe('checkCompatibility', () => {
  it('blocks denylisted versions', () => {
    expect(checkCompatibility(policy, '9.9.9', '1.0.0')).toEqual({
      ok: false,
      detail: 'denylisted_version',
    });
  });

  it('blocks a denylisted version sent with a v-prefix (normalizes both sides)', () => {
    expect(checkCompatibility(policy, 'v9.9.9', '1.0.0')).toEqual({
      ok: false,
      detail: 'denylisted_version',
    });
    const vPolicy: CompatibilityPolicy = { ...policy, denylistedVersions: ['v9.9.9'] };
    expect(checkCompatibility(vPolicy, '9.9.9', '1.0.0')).toEqual({
      ok: false,
      detail: 'denylisted_version',
    });
  });

  it('blocks a desktop below the minimum', () => {
    expect(checkCompatibility(policy, '0.9.0', '1.0.0')).toEqual({
      ok: false,
      detail: 'desktop_below_min',
    });
  });

  it('blocks a parser below the minimum', () => {
    expect(checkCompatibility(policy, '1.0.0', '0.1.0')).toEqual({
      ok: false,
      detail: 'parser_below_min',
    });
  });

  it('accepts versions at or above the minimum, stripping a leading v-prefix', () => {
    expect(checkCompatibility(policy, 'v1.4.0', '2.0.0-beta.1')).toEqual({ ok: true });
  });

  it('blocks a prerelease below the same-core release minimum (semver §11 precedence)', () => {
    const min: CompatibilityPolicy = { ...policy, minDesktopVersion: '1.0.0' };
    expect(checkCompatibility(min, '1.0.0-beta', '1.0.0')).toEqual({
      ok: false,
      detail: 'desktop_below_min',
    });
  });

  it('orders prerelease identifiers numerically, not lexically (1.0.0-beta.2 < beta.11)', () => {
    const min: CompatibilityPolicy = { ...policy, minDesktopVersion: '1.0.0-beta.11' };
    expect(checkCompatibility(min, '1.0.0-beta.2', '1.0.0').ok).toBe(false);
    expect(checkCompatibility(min, '1.0.0-beta.11', '1.0.0')).toEqual({ ok: true });
  });
});

describe('getCompatibilityPolicy', () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  beforeEach(() => {
    __resetPolicyCache();
  });

  afterEach(() => {
    __resetPolicyCache();
  });

  it('fetches and returns a fresh policy', async () => {
    interceptPolicy(200, policy);
    const res = await getCompatibilityPolicy(env, logger);
    expect(res).toEqual({ ok: true, policy, degraded: false });
  });

  it('serves the cached policy without re-fetching while fresh', async () => {
    interceptPolicy(200, policy);
    await getCompatibilityPolicy(env, logger);
    // No second intercept registered: a fetch here would fail net-connect. A fresh cache hit avoids it.
    const res = await getCompatibilityPolicy(env, logger);
    expect(res).toEqual({ ok: true, policy, degraded: false });
  });

  it('fails closed on a cold miss when the control plane is unreachable', async () => {
    interceptPolicy(503, { error: 'down' });
    const res = await getCompatibilityPolicy(env, logger);
    expect(res).toEqual({ ok: false, reason: 'policy_unavailable' });
  });

  it('fails closed on a cold miss when the policy payload is malformed', async () => {
    interceptPolicy(200, { minDesktopVersion: '1.0.0' }); // missing denylistedVersions/updatedAt
    const res = await getCompatibilityPolicy(env, logger);
    expect(res).toEqual({ ok: false, reason: 'policy_unavailable' });
  });

  it('logs policy_unavailable before the cold-miss fail-closed return (no silent error)', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    interceptPolicy(503, { error: 'down' });
    await getCompatibilityPolicy(env, logger);
    expect(errorSpy).toHaveBeenCalledWith('agent_ingest.policy_unavailable');
    errorSpy.mockRestore();
  });

  it('serves the last-good policy (degraded) when a refresh fails after the TTL', async () => {
    const t0 = 1_700_000_000_000;
    let now = t0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      interceptPolicy(200, policy);
      await getCompatibilityPolicy(env, logger);

      now = t0 + 61_000; // past the 60s freshness TTL → forces a refresh
      interceptPolicy(503, { error: 'down' });
      const res = await getCompatibilityPolicy(env, logger);
      expect(res).toEqual({ ok: true, policy, degraded: true });
    } finally {
      Date.now = realNow;
    }
  });
});
