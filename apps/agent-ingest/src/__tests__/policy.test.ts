import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorkerLogger } from '@trace-flow/logging';
import {
  __resetPolicyCache,
  checkCompatibility,
  getCompatibilityPolicy,
  type CompatibilityPolicy,
} from '../policy';
import type * as PolicyModule from '../policy';

const CONVEX = 'https://convex.test';
const OTHER_CONVEX = 'https://other-convex.test';
const env = { CONVEX_SITE_URL: CONVEX, AGENT_INGEST_SHARED_SECRET: 'shared-secret' };
const REQUEST_URL = 'https://ingest.test/v1/ingest';

const logger = createWorkerLogger({
  service: 'agent-ingest',
  request: new Request(REQUEST_URL, { method: 'POST' }),
});

/** A new module instance has empty isolate memory but shares `caches.default`, like a new isolate. */
async function loadInNewIsolate(): Promise<typeof PolicyModule> {
  vi.resetModules();
  return import('../policy');
}

const policy: CompatibilityPolicy = {
  minDesktopVersion: '1.0.0',
  minParserVersion: '1.0.0',
  denylistedVersions: ['9.9.9'],
  updatedAt: 1_700_000_000_000,
};

/**
 * Queued policy responses, consumed in order. Each `getCompatibilityPolicy` GET to
 * `/agent-ingest/compatibility-policy` pops the next queued reply; any other request, or an
 * exhausted queue, throws so unexpected/un-stubbed fetches fail loudly (net-connect disabled).
 */
let policyResponses: { status: number; body: string }[] = [];

function interceptPolicy(status: number, body: unknown): void {
  policyResponses.push({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

function installFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (
      req.method === 'GET' &&
      (url.origin === CONVEX || url.origin === OTHER_CONVEX) &&
      url.pathname === '/agent-ingest/compatibility-policy'
    ) {
      const next = policyResponses.shift();
      if (!next) throw new Error(`unexpected fetch (no queued policy reply): ${req.url}`);
      return new Response(next.body, { status: next.status });
    }
    throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
  });
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
  beforeEach(async () => {
    await __resetPolicyCache(env, REQUEST_URL);
    policyResponses = [];
    installFetchMock();
  });

  afterEach(async () => {
    await __resetPolicyCache(env, REQUEST_URL);
    vi.restoreAllMocks();
  });

  it('fetches and returns a fresh policy', async () => {
    interceptPolicy(200, policy);
    const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
    expect(res).toEqual({ ok: true, policy, degraded: false });
  });

  it('serves the cached policy without re-fetching while fresh', async () => {
    interceptPolicy(200, policy);
    await getCompatibilityPolicy(env, logger, REQUEST_URL);
    // No second intercept registered: a fetch here would fail net-connect. A fresh cache hit avoids it.
    const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
    expect(res).toEqual({ ok: true, policy, degraded: false });
  });

  it('serves a policy another isolate fetched without calling Convex again', async () => {
    interceptPolicy(200, policy);
    await getCompatibilityPolicy(env, logger, REQUEST_URL);

    // No second intercept registered: only the data-center copy can answer.
    const isolate = await loadInNewIsolate();
    const res = await isolate.getCompatibilityPolicy(env, logger, REQUEST_URL);
    expect(res).toEqual({ ok: true, policy, degraded: false });
  });

  it('refetches in a new isolate once the data-center copy is past the TTL', async () => {
    const t0 = 1_700_000_000_000;
    let now = t0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      interceptPolicy(200, policy);
      await getCompatibilityPolicy(env, logger, REQUEST_URL);

      now = t0 + 61_000;
      const updated: CompatibilityPolicy = { ...policy, minDesktopVersion: '2.0.0' };
      interceptPolicy(200, updated);
      const isolate = await loadInNewIsolate();
      const res = await isolate.getCompatibilityPolicy(env, logger, REQUEST_URL);
      expect(res).toEqual({ ok: true, policy: updated, degraded: false });
      expect(policyResponses).toHaveLength(0);
    } finally {
      Date.now = realNow;
    }
  });

  it('keeps data-center copies separate per request origin', async () => {
    interceptPolicy(200, policy);
    await getCompatibilityPolicy(env, logger, REQUEST_URL);

    const previewPolicy: CompatibilityPolicy = { ...policy, minParserVersion: '3.0.0' };
    interceptPolicy(200, previewPolicy);
    const isolate = await loadInNewIsolate();
    const previewUrl = 'https://preview.ingest.test/v1/ingest';
    try {
      const res = await isolate.getCompatibilityPolicy(env, logger, previewUrl);
      expect(res).toEqual({ ok: true, policy: previewPolicy, degraded: false });
    } finally {
      await isolate.__resetPolicyCache(env, previewUrl);
    }
  });

  it('keeps data-center copies separate per Convex deployment', async () => {
    interceptPolicy(200, policy);
    await getCompatibilityPolicy(env, logger, REQUEST_URL);

    const redeployedEnv = { ...env, CONVEX_SITE_URL: OTHER_CONVEX };
    const redeployedPolicy: CompatibilityPolicy = { ...policy, denylistedVersions: [] };
    interceptPolicy(200, redeployedPolicy);
    const isolate = await loadInNewIsolate();
    try {
      const res = await isolate.getCompatibilityPolicy(redeployedEnv, logger, REQUEST_URL);
      expect(res).toEqual({ ok: true, policy: redeployedPolicy, degraded: false });
    } finally {
      await isolate.__resetPolicyCache(redeployedEnv, REQUEST_URL);
    }
  });

  it('fetches from Convex when the data-center cache read fails', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    vi.spyOn(Cache.prototype, 'match').mockRejectedValueOnce(new Error('cache unavailable'));
    interceptPolicy(200, policy);
    const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
    expect(res).toEqual({ ok: true, policy, degraded: false });
    expect(errorSpy).toHaveBeenCalledWith(
      'agent_ingest.policy_cache_read_failed',
      expect.any(Error),
    );
  });

  it('fetches from Convex when the data-center copy is not valid JSON', async () => {
    vi.spyOn(Cache.prototype, 'match').mockResolvedValueOnce(new Response('{'));
    interceptPolicy(200, policy);
    const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
    expect(res).toEqual({ ok: true, policy, degraded: false });
  });

  it('serves the fetched policy when the data-center cache write fails', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    vi.spyOn(Cache.prototype, 'put').mockRejectedValueOnce(new Error('cache unavailable'));
    interceptPolicy(200, policy);
    const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
    expect(res).toEqual({ ok: true, policy, degraded: false });
    expect(errorSpy).toHaveBeenCalledWith(
      'agent_ingest.policy_cache_write_failed',
      expect.any(Error),
    );
  });

  it('fails closed on a cold miss when the control plane is unreachable', async () => {
    interceptPolicy(503, { error: 'down' });
    const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
    expect(res).toEqual({ ok: false, reason: 'policy_unavailable' });
  });

  it('fails closed on a cold miss when the policy payload is malformed', async () => {
    interceptPolicy(200, { minDesktopVersion: '1.0.0' }); // missing denylistedVersions/updatedAt
    const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
    expect(res).toEqual({ ok: false, reason: 'policy_unavailable' });
  });

  it('logs policy_unavailable before the cold-miss fail-closed return (no silent error)', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    interceptPolicy(503, { error: 'down' });
    await getCompatibilityPolicy(env, logger, REQUEST_URL);
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
      await getCompatibilityPolicy(env, logger, REQUEST_URL);

      now = t0 + 61_000; // past the 60s freshness TTL → forces a refresh
      interceptPolicy(503, { error: 'down' });
      const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
      expect(res).toEqual({ ok: true, policy, degraded: true });
    } finally {
      Date.now = realNow;
    }
  });

  it('serves the last-good policy (degraded) when the cache read and refresh both fail', async () => {
    const t0 = 1_700_000_000_000;
    let now = t0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      interceptPolicy(200, policy);
      await getCompatibilityPolicy(env, logger, REQUEST_URL);

      now = t0 + 61_000;
      vi.spyOn(Cache.prototype, 'match').mockRejectedValueOnce(new Error('cache unavailable'));
      interceptPolicy(503, { error: 'down' });
      const res = await getCompatibilityPolicy(env, logger, REQUEST_URL);
      expect(res).toEqual({ ok: true, policy, degraded: true });
    } finally {
      Date.now = realNow;
    }
  });
});
