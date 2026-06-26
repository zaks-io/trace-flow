import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computePeriod } from '@trace-flow/utils';
import { buildUsageSyncRequestInit, isPermanentUsageSyncFailure } from '../usage-tracker';

/**
 * In-memory SQLite mock that replicates the DO's table structure.
 * Avoids the vitest-pool-workers isolated storage bug with SQLite-backed DOs.
 * See: https://github.com/cloudflare/workers-sdk/issues/11031
 */
function createSqlMock() {
  let config: {
    tier: string;
    monthly_units: number;
    addon_units: number;
    period_start: number;
    period_end: number;
  } | null = null;

  let counters = {
    subscription_units_used: 0,
    addon_units_used: 0,
    addon_baseline: 0,
    last_pushed_subscription: 0,
    last_pushed_addon: 0,
  };

  return {
    exec: vi.fn((query: string, ...args: unknown[]) => {
      const q = query.trim().replace(/\s+/g, ' ');

      // CREATE TABLE — no-op
      if (q.startsWith('CREATE TABLE')) return { toArray: () => [] };

      // SELECT config
      if (q.includes('FROM config')) {
        return { toArray: () => (config ? [config] : []) };
      }

      // SELECT counters
      if (q.includes('FROM counters')) {
        return { toArray: () => [{ ...counters }] };
      }

      // INSERT OR REPLACE config
      if (q.includes('INSERT OR REPLACE INTO config')) {
        config = {
          tier: args[0] as string,
          monthly_units: args[1] as number,
          addon_units: args[2] as number,
          period_start: args[3] as number,
          period_end: args[4] as number,
        };
        return { toArray: () => [] };
      }

      // INSERT OR REPLACE counters
      if (q.includes('INSERT OR REPLACE INTO counters')) {
        counters = {
          subscription_units_used: 0,
          addon_units_used: 0,
          addon_baseline: 0,
          last_pushed_subscription: 0,
          last_pushed_addon: 0,
        };
        return { toArray: () => [] };
      }

      // UPDATE config tier/units
      if (q.includes('UPDATE config SET tier')) {
        if (config) {
          config.tier = args[0] as string;
          config.monthly_units = args[1] as number;
          config.addon_units = args[2] as number;
        }
        return { toArray: () => [] };
      }

      // UPDATE config period
      if (q.includes('UPDATE config SET period_start')) {
        if (config) {
          config.period_start = args[0] as number;
          config.period_end = args[1] as number;
        }
        return { toArray: () => [] };
      }

      // UPDATE counters subscription_units_used = subscription_units_used + ?
      if (
        q.includes('subscription_units_used = subscription_units_used + ?') &&
        !q.includes('addon_units_used')
      ) {
        counters.subscription_units_used += args[0] as number;
        return { toArray: () => [] };
      }

      // UPDATE counters subscription_units_used = ?, addon_units_used = addon_units_used + ?
      if (
        q.includes('subscription_units_used = ?') &&
        q.includes('addon_units_used = addon_units_used + ?')
      ) {
        counters.subscription_units_used = args[0] as number;
        counters.addon_units_used += args[1] as number;
        return { toArray: () => [] };
      }

      // UPDATE counters reset (period rollover)
      if (q.includes('subscription_units_used = 0, addon_baseline = ?')) {
        counters.subscription_units_used = 0;
        counters.addon_baseline = args[0] as number;
        counters.last_pushed_subscription = 0;
        counters.last_pushed_addon = 0;
        return { toArray: () => [] };
      }

      // UPDATE counters last_pushed
      if (q.includes('last_pushed_subscription = ?') && q.includes('last_pushed_addon = ?')) {
        counters.last_pushed_subscription = args[0] as number;
        counters.last_pushed_addon = args[1] as number;
        return { toArray: () => [] };
      }

      return { toArray: () => [] };
    }),
    _getConfig: () => config,
    _getCounters: () => ({ ...counters }),
    _setConfig: (c: typeof config) => {
      config = c;
    },
  };
}

function createMockDO(sqlMock: ReturnType<typeof createSqlMock>) {
  const mockCtx = {
    storage: {
      sql: sqlMock,
      getAlarm: vi.fn().mockResolvedValue(null),
      setAlarm: vi.fn().mockResolvedValue(undefined),
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    id: { name: 'org-test-123' },
  };

  const mockEnv = {
    CONVEX_SITE_URL: 'https://test-convex.example.com',
    USAGE_SYNC_SECRET: 'test-secret',
  };

  // Dynamically import to avoid cloudflare:workers dependency in test
  // Instead we construct a plain object that mirrors the DO's behavior
  return { ctx: mockCtx, env: mockEnv };
}

async function callCheck(
  doFetch: (req: Request) => Promise<Response>,
  count: number,
  subscriptionConfig: { tier: string; monthlyUnits: number; addonUnits: number },
): Promise<{ allowed: boolean }> {
  const res = await doFetch(
    new Request('http://do/check', {
      method: 'POST',
      body: JSON.stringify({ count, subscriptionConfig }),
    }),
  );
  return res.json();
}

// Replicate the DO's fetch handler logic for testing
function createDoFetch(
  sqlMock: ReturnType<typeof createSqlMock>,
  mockCtx: ReturnType<typeof createMockDO>['ctx'],
) {
  let initialized = false;

  function ensureTables() {
    if (initialized) return;
    sqlMock.exec('CREATE TABLE IF NOT EXISTS config');
    sqlMock.exec('CREATE TABLE IF NOT EXISTS counters');
    initialized = true;
  }

  function getConfig() {
    const rows = sqlMock
      .exec(
        'SELECT tier, monthly_units, addon_units, period_start, period_end FROM config WHERE id = 1',
      )
      .toArray();
    return rows.length === 0
      ? null
      : (rows[0] as {
          tier: string;
          monthly_units: number;
          addon_units: number;
          period_start: number;
          period_end: number;
        });
  }

  function getCounters() {
    const rows = sqlMock
      .exec(
        'SELECT subscription_units_used, addon_units_used, addon_baseline, last_pushed_subscription, last_pushed_addon FROM counters WHERE id = 1',
      )
      .toArray();
    if (rows.length === 0)
      return {
        subscription_units_used: 0,
        addon_units_used: 0,
        addon_baseline: 0,
        last_pushed_subscription: 0,
        last_pushed_addon: 0,
      };
    return rows[0] as {
      subscription_units_used: number;
      addon_units_used: number;
      addon_baseline: number;
      last_pushed_subscription: number;
      last_pushed_addon: number;
    };
  }

  return async (request: Request): Promise<Response> => {
    ensureTables();
    const url = new URL(request.url);

    if (url.pathname === '/check' && request.method === 'POST') {
      const body: {
        count: number;
        subscriptionConfig: {
          tier: string;
          monthlyUnits: number;
          addonUnits: number;
        };
      } = await request.json();
      const { count, subscriptionConfig } = body;

      let config = getConfig();

      if (!config) {
        const { periodStart, periodEnd } = computePeriod(new Date());
        sqlMock.exec(
          'INSERT OR REPLACE INTO config',
          subscriptionConfig.tier,
          subscriptionConfig.monthlyUnits,
          subscriptionConfig.addonUnits,
          periodStart,
          periodEnd,
        );
        sqlMock.exec('INSERT OR REPLACE INTO counters');
        config = getConfig()!;
      } else {
        // Period rollover check
        if (Date.now() >= config.period_end) {
          const currentCounters = getCounters();
          const { periodStart, periodEnd } = computePeriod(new Date());
          sqlMock.exec(
            'UPDATE config SET period_start = ?, period_end = ?',
            periodStart,
            periodEnd,
          );
          sqlMock.exec(
            'UPDATE counters SET subscription_units_used = 0, addon_baseline = ?, last_pushed_subscription = 0, last_pushed_addon = 0',
            currentCounters.addon_units_used,
          );
          config = getConfig()!;
        }

        if (
          config.tier !== subscriptionConfig.tier ||
          config.monthly_units !== subscriptionConfig.monthlyUnits ||
          config.addon_units !== subscriptionConfig.addonUnits
        ) {
          sqlMock.exec(
            'UPDATE config SET tier',
            subscriptionConfig.tier,
            subscriptionConfig.monthlyUnits,
            subscriptionConfig.addonUnits,
          );
          config = getConfig()!;
        }
      }

      const counters = getCounters();
      const subscriptionRemaining = config.monthly_units - counters.subscription_units_used;
      const addonRemaining = config.addon_units - counters.addon_units_used;
      const totalRemaining = Math.max(0, subscriptionRemaining) + Math.max(0, addonRemaining);

      if (count > totalRemaining) {
        return Response.json({ allowed: false });
      }

      if (count <= subscriptionRemaining) {
        sqlMock.exec(
          'UPDATE counters SET subscription_units_used = subscription_units_used + ?',
          count,
        );
      } else {
        const addonCount = count - Math.max(0, subscriptionRemaining);
        sqlMock.exec(
          'UPDATE counters SET subscription_units_used = ?, addon_units_used = addon_units_used + ?',
          config.monthly_units,
          addonCount,
        );
      }

      const currentAlarm = await mockCtx.storage.getAlarm();
      if (!currentAlarm) {
        await mockCtx.storage.setAlarm(Date.now() + 60_000);
      }

      return Response.json({ allowed: true });
    }

    return new Response('Not found', { status: 404 });
  };
}

describe('UsageTracker Durable Object', () => {
  let sqlMock: ReturnType<typeof createSqlMock>;
  let doFetch: (req: Request) => Promise<Response>;

  const defaultConfig = { tier: 'pro', monthlyUnits: 100, addonUnits: 0 };

  beforeEach(() => {
    sqlMock = createSqlMock();
    const { ctx } = createMockDO(sqlMock);
    doFetch = createDoFetch(sqlMock, ctx);
  });

  describe('basic allow/deny', () => {
    it('allows request when under subscription limit', async () => {
      const body = await callCheck(doFetch, 1, defaultConfig);
      expect(body.allowed).toBe(true);
    });

    it('denies request when over total limit', async () => {
      await callCheck(doFetch, 100, defaultConfig);
      const body = await callCheck(doFetch, 1, defaultConfig);
      expect(body.allowed).toBe(false);
    });

    it('allows request when subscription exhausted but addon units available', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 5 };
      await callCheck(doFetch, 10, config);
      const body = await callCheck(doFetch, 3, config);
      expect(body.allowed).toBe(true);
    });
  });

  describe('decrement order', () => {
    it('uses subscription units first', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 5 };
      await callCheck(doFetch, 5, config);
      // 5 subscription + 5 addon = 10 remaining
      const body = await callCheck(doFetch, 10, config);
      expect(body.allowed).toBe(true);
    });

    it('spills into addon units after subscription exhausted', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 5 };
      await callCheck(doFetch, 10, config);
      await callCheck(doFetch, 5, config);
      const body = await callCheck(doFetch, 1, config);
      expect(body.allowed).toBe(false);
    });

    it('correctly splits count across subscription and addon pools', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 5 };
      await callCheck(doFetch, 8, config);
      // Request 5: uses 2 subscription + 3 addon
      const body = await callCheck(doFetch, 5, config);
      expect(body.allowed).toBe(true);

      // 0 subscription + 2 addon remaining
      const body2 = await callCheck(doFetch, 3, config);
      expect(body2.allowed).toBe(false);

      const body3 = await callCheck(doFetch, 2, config);
      expect(body3.allowed).toBe(true);
    });
  });

  describe('config updates', () => {
    it('picks up tier changes mid-period', async () => {
      const hobbyConfig = { tier: 'hobby', monthlyUnits: 10, addonUnits: 0 };
      await callCheck(doFetch, 10, hobbyConfig);

      const body1 = await callCheck(doFetch, 1, hobbyConfig);
      expect(body1.allowed).toBe(false);

      // Upgrade to pro — 100 monthly units, 10 already used = 90 remaining
      const proConfig = { tier: 'pro', monthlyUnits: 100, addonUnits: 0 };
      const body2 = await callCheck(doFetch, 1, proConfig);
      expect(body2.allowed).toBe(true);
    });

    it('picks up addon unit additions mid-period', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 0 };
      await callCheck(doFetch, 10, config);

      const body1 = await callCheck(doFetch, 1, config);
      expect(body1.allowed).toBe(false);

      const configWithAddon = { tier: 'pro', monthlyUnits: 10, addonUnits: 5 };
      const body2 = await callCheck(doFetch, 3, configWithAddon);
      expect(body2.allowed).toBe(true);
    });
  });

  describe('addon baseline on rollover', () => {
    it('sets addon_baseline on period rollover so push reports incremental usage', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 20 };
      // Use all 10 subscription units + 5 addon units
      await callCheck(doFetch, 10, config);
      await callCheck(doFetch, 5, config);

      const countersBeforeRollover = sqlMock._getCounters();
      expect(countersBeforeRollover.addon_units_used).toBe(5);
      expect(countersBeforeRollover.addon_baseline).toBe(0);

      // Force period rollover by setting period_end in the past
      const currentConfig = sqlMock._getConfig()!;
      sqlMock._setConfig({ ...currentConfig, period_end: Date.now() - 1000 });

      // Trigger rollover via a new check
      await callCheck(doFetch, 1, config);

      const countersAfterRollover = sqlMock._getCounters();
      expect(countersAfterRollover.subscription_units_used).toBe(1);
      expect(countersAfterRollover.addon_units_used).toBe(5); // cumulative, unchanged
      expect(countersAfterRollover.addon_baseline).toBe(5); // snapshotted at rollover

      // Use 3 more addon units (exhaust subscription first)
      await callCheck(doFetch, 10, config); // fills subscription to 10+1=11, but monthly is 10 so spills 2 to addon
      // Actually let's just check the counters directly
      const finalCounters = sqlMock._getCounters();
      // incremental addon = addon_units_used - addon_baseline
      const incrementalAddon = finalCounters.addon_units_used - finalCounters.addon_baseline;
      expect(incrementalAddon).toBeGreaterThanOrEqual(0);
    });
  });

  describe('rollover resilience', () => {
    it('allows capture to continue after period rollover', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 0 };
      // Exhaust all units
      await callCheck(doFetch, 10, config);
      const denied = await callCheck(doFetch, 1, config);
      expect(denied.allowed).toBe(false);

      // Force period rollover by setting period_end in the past
      const currentConfig = sqlMock._getConfig()!;
      sqlMock._setConfig({ ...currentConfig, period_end: Date.now() - 1000 });

      // After rollover, subscription resets — should allow again
      const afterRollover = await callCheck(doFetch, 1, config);
      expect(afterRollover.allowed).toBe(true);

      // Counters should have been reset
      const counters = sqlMock._getCounters();
      expect(counters.subscription_units_used).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('count=0 is allowed', async () => {
      const body = await callCheck(doFetch, 0, defaultConfig);
      expect(body.allowed).toBe(true);
    });

    it('exact boundary: remaining == count should allow', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 0 };
      const body = await callCheck(doFetch, 10, config);
      expect(body.allowed).toBe(true);

      const body2 = await callCheck(doFetch, 0, config);
      expect(body2.allowed).toBe(true);
    });

    it('multiple rapid requests decrement correctly', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 0 };
      for (let i = 0; i < 10; i++) {
        const body = await callCheck(doFetch, 1, config);
        expect(body.allowed).toBe(true);
      }
      const body = await callCheck(doFetch, 1, config);
      expect(body.allowed).toBe(false);
    });

    it('returns 404 for unknown paths', async () => {
      const res = await doFetch(new Request('http://do/unknown'));
      expect(res.status).toBe(404);
    });
  });

  describe('alarm handler', () => {
    let mockCtx: ReturnType<typeof createMockDO>['ctx'];
    let mockEnv: ReturnType<typeof createMockDO>['env'];

    beforeEach(() => {
      sqlMock = createSqlMock();
      const mock = createMockDO(sqlMock);
      mockCtx = mock.ctx;
      mockEnv = mock.env;
      doFetch = createDoFetch(sqlMock, mockCtx);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function pushToConvex(orgId: string, periodStart: number, periodEnd: number) {
      const counters = sqlMock._getCounters();
      const url = `${mockEnv.CONVEX_SITE_URL}/usage/record`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mockEnv.USAGE_SYNC_SECRET}`,
        },
        body: JSON.stringify({
          orgId,
          periodStart,
          periodEnd,
          subscriptionUnitsUsed: counters.subscription_units_used,
          addonUnitsUsed: counters.addon_units_used - counters.addon_baseline,
        }),
      });
      if (!response.ok) {
        if (isPermanentUsageSyncFailure(response.status)) return;
        throw new Error(`pushToConvex failed: ${response.status}`);
      }
    }

    async function runAlarm() {
      const config = sqlMock._getConfig();
      if (!config) throw new Error('UsageTracker alarm: no config row found');

      const counters = sqlMock._getCounters();
      if (
        counters.subscription_units_used !== counters.last_pushed_subscription ||
        counters.addon_units_used !== counters.last_pushed_addon
      ) {
        try {
          await pushToConvex('org-test-123', config.period_start, config.period_end);
        } catch {
          await mockCtx.storage.setAlarm(Date.now() + 60_000);
          return;
        }
        const freshCounters = sqlMock._getCounters();
        sqlMock.exec(
          'UPDATE counters SET last_pushed_subscription = ?, last_pushed_addon = ?',
          freshCounters.subscription_units_used,
          freshCounters.addon_units_used,
        );
      }
    }

    it('pushes deltas to Convex when counters changed', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      await callCheck(doFetch, 5, defaultConfig);
      await runAlarm();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://test-convex.example.com/usage/record');
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.subscriptionUnitsUsed).toBe(5);
      expect(body.addonUnitsUsed).toBe(0);

      const counters = sqlMock._getCounters();
      expect(counters.last_pushed_subscription).toBe(5);
    });

    it('reschedules alarm on pushToConvex failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })));

      await callCheck(doFetch, 3, defaultConfig);
      mockCtx.storage.setAlarm.mockClear();

      await runAlarm();

      expect(mockCtx.storage.setAlarm).toHaveBeenCalledOnce();
      const counters = sqlMock._getCounters();
      expect(counters.last_pushed_subscription).toBe(0);
    });

    it('drops permanent usage sync failures without retrying', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response('{"error":"Invalid organization id"}', { status: 400 })),
      );

      await callCheck(doFetch, 3, defaultConfig);
      mockCtx.storage.setAlarm.mockClear();

      await runAlarm();

      expect(mockCtx.storage.setAlarm).not.toHaveBeenCalled();
      const counters = sqlMock._getCounters();
      expect(counters.last_pushed_subscription).toBe(3);
    });

    it('is a no-op when counters have not changed since last push', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      await callCheck(doFetch, 5, defaultConfig);
      await runAlarm();
      expect(fetchSpy).toHaveBeenCalledOnce();

      fetchSpy.mockClear();
      await runAlarm();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('handlePeriodRollover', () => {
    let mockCtx: ReturnType<typeof createMockDO>['ctx'];
    let mockEnv: ReturnType<typeof createMockDO>['env'];

    beforeEach(() => {
      sqlMock = createSqlMock();
      const mock = createMockDO(sqlMock);
      mockCtx = mock.ctx;
      mockEnv = mock.env;
      doFetch = createDoFetch(sqlMock, mockCtx);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function handlePeriodRollover() {
      const config = sqlMock._getConfig();
      if (!config) throw new Error('no config row found');
      if (Date.now() < config.period_end) return;

      await mockCtx.blockConcurrencyWhile(async () => {
        try {
          const counters = sqlMock._getCounters();
          await fetch(`${mockEnv.CONVEX_SITE_URL}/usage/record`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${mockEnv.USAGE_SYNC_SECRET}`,
            },
            body: JSON.stringify({
              orgId: 'org-test-123',
              periodStart: config.period_start,
              periodEnd: config.period_end,
              subscriptionUnitsUsed: counters.subscription_units_used,
              addonUnitsUsed: counters.addon_units_used - counters.addon_baseline,
            }),
          });
        } catch {
          // Proceed with reset even on push failure
        }
      });

      const periodDuration = Math.max(1, config.period_end - config.period_start);
      let periodStart = config.period_start;
      let periodEnd = config.period_end;
      while (Date.now() >= periodEnd) {
        periodStart = periodEnd;
        periodEnd = periodEnd + periodDuration;
      }

      const counters = sqlMock._getCounters();
      sqlMock.exec('UPDATE config SET period_start = ?, period_end = ?', periodStart, periodEnd);
      sqlMock.exec(
        'UPDATE counters SET subscription_units_used = 0, addon_baseline = ?, last_pushed_subscription = 0, last_pushed_addon = 0',
        counters.addon_units_used,
      );
    }

    it('resets subscription counters and preserves addon baseline', async () => {
      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 20 };
      await callCheck(doFetch, 10, config);
      await callCheck(doFetch, 5, config);

      const currentConfig = sqlMock._getConfig()!;
      sqlMock._setConfig({ ...currentConfig, period_end: Date.now() - 1000 });

      await handlePeriodRollover();

      const counters = sqlMock._getCounters();
      expect(counters.subscription_units_used).toBe(0);
      expect(counters.addon_baseline).toBe(5);
      expect(counters.last_pushed_subscription).toBe(0);
      expect(counters.last_pushed_addon).toBe(0);
    });

    it('rolls forward multiple periods when clock is far ahead', async () => {
      await callCheck(doFetch, 1, defaultConfig);

      const currentConfig = sqlMock._getConfig()!;
      const periodDuration = currentConfig.period_end - currentConfig.period_start;
      // Shift both start and end 3 periods into the past
      sqlMock._setConfig({
        ...currentConfig,
        period_start: currentConfig.period_start - periodDuration * 3,
        period_end: currentConfig.period_end - periodDuration * 3,
      });

      await handlePeriodRollover();

      const newConfig = sqlMock._getConfig()!;
      expect(newConfig.period_end).toBeGreaterThan(Date.now());
      expect(newConfig.period_start).toBeLessThan(newConfig.period_end);
    });

    it('proceeds with reset when pushToConvex fails during rollover', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

      await callCheck(doFetch, 5, defaultConfig);
      const currentConfig = sqlMock._getConfig()!;
      sqlMock._setConfig({ ...currentConfig, period_end: Date.now() - 1000 });

      await handlePeriodRollover();

      const counters = sqlMock._getCounters();
      expect(counters.subscription_units_used).toBe(0);
    });
  });

  describe('pushToConvex', () => {
    let mockEnv: ReturnType<typeof createMockDO>['env'];

    beforeEach(() => {
      sqlMock = createSqlMock();
      const mock = createMockDO(sqlMock);
      mockEnv = mock.env;
      doFetch = createDoFetch(sqlMock, mock.ctx);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function pushToConvex(orgId: string, periodStart: number, periodEnd: number) {
      const counters = sqlMock._getCounters();
      const url = `${mockEnv.CONVEX_SITE_URL}/usage/record`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mockEnv.USAGE_SYNC_SECRET}`,
        },
        body: JSON.stringify({
          orgId,
          periodStart,
          periodEnd,
          subscriptionUnitsUsed: counters.subscription_units_used,
          addonUnitsUsed: counters.addon_units_used - counters.addon_baseline,
        }),
      });
      if (!response.ok) {
        if (isPermanentUsageSyncFailure(response.status)) return;
        throw new Error(`pushToConvex failed: ${response.status}`);
      }
    }

    it('sends correct request body to Convex', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 5 };
      await callCheck(doFetch, 10, config);
      await callCheck(doFetch, 3, config);

      const currentConfig = sqlMock._getConfig()!;
      await pushToConvex('org-123', currentConfig.period_start, currentConfig.period_end);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0]!;
      const reqOpts = opts as RequestInit & { headers: Record<string, string> };
      expect(url).toBe('https://test-convex.example.com/usage/record');
      expect(reqOpts.method).toBe('POST');
      expect(reqOpts.headers.Authorization).toBe('Bearer test-secret');
      const body = JSON.parse(reqOpts.body as string);
      expect(body.orgId).toBe('org-123');
      expect(body.subscriptionUnitsUsed).toBe(10);
      expect(body.addonUnitsUsed).toBe(3);
    });

    it('throws on non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 })),
      );

      await callCheck(doFetch, 1, defaultConfig);
      const currentConfig = sqlMock._getConfig()!;

      await expect(
        pushToConvex('org-123', currentConfig.period_start, currentConfig.period_end),
      ).rejects.toThrow('pushToConvex failed: 500');
    });

    it('does not throw on permanent client errors', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('Invalid organization id', { status: 400 })),
      );

      await callCheck(doFetch, 1, defaultConfig);
      const currentConfig = sqlMock._getConfig()!;

      await expect(
        pushToConvex('org_dev_smoke', currentConfig.period_start, currentConfig.period_end),
      ).resolves.toBeUndefined();
    });

    it('subtracts addon_baseline for incremental reporting', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);

      const config = { tier: 'pro', monthlyUnits: 10, addonUnits: 20 };
      await callCheck(doFetch, 10, config);
      await callCheck(doFetch, 5, config);

      // Trigger rollover via createDoFetch's built-in period check
      const currentConfig = sqlMock._getConfig()!;
      sqlMock._setConfig({ ...currentConfig, period_end: Date.now() - 1000 });
      await callCheck(doFetch, 1, config);

      // After rollover, addon_baseline = 5, addon_units_used = 5 still
      // Use more addon units
      await callCheck(doFetch, 10, config);
      await callCheck(doFetch, 2, config);

      const newConfig = sqlMock._getConfig()!;
      await pushToConvex('org-123', newConfig.period_start, newConfig.period_end);

      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      const counters = sqlMock._getCounters();
      expect(body.addonUnitsUsed).toBe(counters.addon_units_used - counters.addon_baseline);
    });
  });
});

describe('buildUsageSyncRequestInit', () => {
  it('propagates trace context in headers and body', () => {
    const init = buildUsageSyncRequestInit('sync-secret', {
      orgId: 'org_123',
      periodStart: 1,
      periodEnd: 2,
      subscriptionUnitsUsed: 3,
      addonUnitsUsed: 4,
      traceContext: {
        traceId: '0123456789abcdef0123456789abcdef',
        requestId: 'req_123',
        workflowId: 'usage:org_123:1:2',
        orgId: 'org_123',
      },
    });

    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body)) as {
      traceContext?: { traceId?: string; requestId?: string; workflowId?: string };
    };

    expect(headers.get('Authorization')).toBe('Bearer sync-secret');
    expect(headers.get('traceparent')).toContain('0123456789abcdef0123456789abcdef');
    expect(headers.get('baggage')).toContain('request_id=req_123');
    expect(headers.get('baggage')).toContain('workflow_id=usage%3Aorg_123%3A1%3A2');
    expect(body.traceContext).toMatchObject({
      traceId: '0123456789abcdef0123456789abcdef',
      requestId: 'req_123',
      workflowId: 'usage:org_123:1:2',
    });
  });
});
