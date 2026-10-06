import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionKVData } from '@trace-flow/types';
import type { UsageSnapshot } from '../usage-period';
import type { UsageTracker } from '../usage-tracker';

const usageNamespace = env.USAGE_TRACKER as unknown as DurableObjectNamespace<
  InstanceType<typeof UsageTracker>
>;
const DAY = 86_400_000;

function tracker(overrides: Partial<SubscriptionKVData> = {}) {
  const orgId = `usage-${crypto.randomUUID()}`;
  const stub = usageNamespace.get(usageNamespace.idFromName(orgId));
  const config: SubscriptionKVData = {
    tier: 'pro',
    status: 'active',
    monthlyUnits: 10,
    addonUnits: 5,
    currentPeriodStart: Date.now() - 60_000,
    currentPeriodEnd: Date.now() + DAY,
    ...overrides,
  };
  return {
    orgId,
    stub,
    config,
    check: async (count: number, subscriptionConfig = config) => {
      const response = await stub.fetch('https://usage.internal/check', {
        method: 'POST',
        body: JSON.stringify({ orgId, count, subscriptionConfig }),
      });
      return response.json<{ allowed: boolean; periodEnd?: number }>();
    },
  };
}

function syncRecorder(status = 200) {
  const sent: UsageSnapshot[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)) as UsageSnapshot);
    return new Response(null, { status });
  });
  return { sent, fetchMock };
}

async function counters(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{
        subscription_units_used: number;
        addon_units_used: number;
        last_pushed_subscription: number;
        last_pushed_addon: number;
      }>('SELECT * FROM counters')
      .one(),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('UsageTracker accounting in workerd', () => {
  it('counts repeated expired upstream periods once without request-time synchronization', async () => {
    const { sent } = syncRecorder();
    const t = tracker({
      currentPeriodStart: Date.now() - 200 * DAY,
      currentPeriodEnd: Date.now() - 170 * DAY,
    });
    for (let i = 0; i < 3; i++) expect(await t.check(1)).toEqual({ allowed: true });
    expect(sent).toEqual([]);
    expect(await counters(t.stub)).toMatchObject({ subscription_units_used: 3 });
    expect(await runDurableObjectAlarm(t.stub)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subscriptionUnitsUsed: 3, addonUnitsUsed: 0 });
    expect(sent[0]!.periodStart).toBeGreaterThan(t.config.currentPeriodEnd!);
  });

  it('uses subscription units then addons and denies above the exact remaining limit', async () => {
    const { sent } = syncRecorder();
    const t = tracker();
    expect(await t.check(8)).toEqual({ allowed: true });
    expect(await t.check(7)).toEqual({ allowed: true });
    expect(await t.check(1)).toMatchObject({ allowed: false });
    expect(await t.check(0)).toEqual({ allowed: true });
    await runDurableObjectAlarm(t.stub);
    expect(sent[0]).toMatchObject({ subscriptionUnitsUsed: 10, addonUnitsUsed: 5 });
  });

  it('applies entitlement changes without reducing already consumed units on a downgrade', async () => {
    const { sent } = syncRecorder();
    const t = tracker();
    await t.check(8);
    expect(await t.check(3, { ...t.config, monthlyUnits: 5 })).toEqual({ allowed: true });
    expect(await t.check(3, { ...t.config, monthlyUnits: 5 })).toMatchObject({ allowed: false });
    expect(await t.check(5, { ...t.config, monthlyUnits: 5, addonUnits: 10 })).toEqual({
      allowed: true,
    });
    await runDurableObjectAlarm(t.stub);
    expect(sent[0]).toMatchObject({ subscriptionUnitsUsed: 8, addonUnitsUsed: 8 });
  });

  it('keeps completed totals durably across a failed sync, rollover, and eviction', async () => {
    const { sent, fetchMock } = syncRecorder(503);
    const t = tracker();
    await t.check(13);
    const next = {
      ...t.config,
      currentPeriodStart: t.config.currentPeriodEnd!,
      currentPeriodEnd: t.config.currentPeriodEnd! + DAY,
    };
    expect(await t.check(11, next)).toEqual({ allowed: true });
    expect(await runDurableObjectAlarm(t.stub)).toBe(true);
    await evictDurableObject(t.stub);
    fetchMock.mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as UsageSnapshot);
      return new Response(null);
    });
    await runDurableObjectAlarm(t.stub);
    expect(
      sent.slice(1).map((s) => [s.periodStart, s.subscriptionUnitsUsed, s.addonUnitsUsed]),
    ).toEqual([
      [t.config.currentPeriodStart, 10, 3],
      [next.currentPeriodStart, 10, 1],
    ]);
    expect(await t.check(2, next)).toMatchObject({ allowed: false });
    expect(await runDurableObjectAlarm(t.stub)).toBe(false);
  });

  it.each([401, 408, 429, 503])('retains unconfirmed totals on HTTP %i', async (status) => {
    const { sent, fetchMock } = syncRecorder(status);
    const t = tracker();
    await t.check(2);
    expect(await runDurableObjectAlarm(t.stub)).toBe(true);
    expect(await counters(t.stub)).toMatchObject({ last_pushed_subscription: 0 });
    const alarmAt = await runInDurableObject(t.stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarmAt).toBeGreaterThanOrEqual(Date.now() + 59_000);
    fetchMock.mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as UsageSnapshot);
      return new Response(null);
    });
    await runDurableObjectAlarm(t.stub);
    expect(sent.map((s) => s.subscriptionUnitsUsed)).toEqual([2, 2]);
    expect(await counters(t.stub)).toMatchObject({ last_pushed_subscription: 2 });
  });

  it.each([400, 404])('advances past rejected periods on HTTP %i', async (status) => {
    const { sent, fetchMock } = syncRecorder();
    const t = tracker();
    await t.check(2);
    const next = {
      ...t.config,
      currentPeriodStart: t.config.currentPeriodEnd!,
      currentPeriodEnd: t.config.currentPeriodEnd! + DAY,
    };
    await t.check(3, next);
    fetchMock.mockImplementationOnce(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as UsageSnapshot);
      return new Response(null, { status });
    });
    await runDurableObjectAlarm(t.stub);
    expect(sent.map((s) => s.subscriptionUnitsUsed)).toEqual([2, 3]);
    expect(await counters(t.stub)).toMatchObject({ last_pushed_subscription: 3 });
    expect(await runDurableObjectAlarm(t.stub)).toBe(false);
  });

  it('drains a full outbox before staging unsynchronized current usage', async () => {
    const { sent } = syncRecorder();
    const t = tracker();
    await t.check(2);
    await runInDurableObject(t.stub, (_instance, state) => {
      for (let i = 0; i < 128; i++) {
        const start = t.config.currentPeriodStart! - (128 - i) * DAY;
        state.storage.sql.exec('INSERT INTO usage_outbox VALUES (?, ?, 1, 0)', start, start + DAY);
      }
    });
    await runDurableObjectAlarm(t.stub);
    expect(sent).toHaveLength(16);
    expect(await counters(t.stub)).toMatchObject({ last_pushed_subscription: 0 });
    for (let i = 0; i < 8; i++) await runDurableObjectAlarm(t.stub);
    expect(sent).toHaveLength(129);
    expect(sent.at(-1)).toMatchObject({ subscriptionUnitsUsed: 2 });
    expect(await runDurableObjectAlarm(t.stub)).toBe(false);
  });

  it('upgrades legacy SQLite state without resetting usage or addon baselines', async () => {
    const { sent } = syncRecorder();
    const t = tracker();
    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec(`CREATE TABLE config (
        id INTEGER PRIMARY KEY DEFAULT 1, org_id TEXT NOT NULL, tier TEXT NOT NULL,
        monthly_units INTEGER NOT NULL, addon_units INTEGER NOT NULL,
        period_start INTEGER NOT NULL, period_end INTEGER NOT NULL
      )`);
      state.storage.sql.exec(`CREATE TABLE counters (
        id INTEGER PRIMARY KEY DEFAULT 1, subscription_units_used INTEGER NOT NULL DEFAULT 0,
        addon_units_used INTEGER NOT NULL DEFAULT 0, addon_baseline INTEGER NOT NULL DEFAULT 0,
        last_pushed_subscription INTEGER NOT NULL DEFAULT 0, last_pushed_addon INTEGER NOT NULL DEFAULT 0
      )`);
      state.storage.sql.exec(
        'INSERT INTO config VALUES (1, ?, ?, 10, 5, ?, ?)',
        t.orgId,
        'pro',
        t.config.currentPeriodStart!,
        t.config.currentPeriodEnd!,
      );
      state.storage.sql.exec('INSERT INTO counters VALUES (1, 8, 3, 3, 8, 0)');
    });
    await evictDurableObject(t.stub);
    expect(await t.check(3)).toEqual({ allowed: true });
    await runDurableObjectAlarm(t.stub);
    expect(sent[0]).toMatchObject({ subscriptionUnitsUsed: 10, addonUnitsUsed: 1 });
    expect(await counters(t.stub)).toMatchObject({ addon_units_used: 4, last_pushed_addon: 4 });
    expect(await t.check(2)).toMatchObject({ allowed: false });
  });

  it('synchronizes a shorter authoritative end after the locally rolled period was confirmed', async () => {
    const { sent } = syncRecorder();
    const t = tracker({
      currentPeriodStart: Date.now() - 32 * DAY,
      currentPeriodEnd: Date.now() - DAY,
    });
    await t.check(2);
    await runDurableObjectAlarm(t.stub);
    const rolled = sent[0]!;
    const shorterEnd = rolled.periodEnd - 3 * DAY;
    const authoritative = {
      ...t.config,
      currentPeriodStart: rolled.periodStart,
      currentPeriodEnd: shorterEnd,
    };
    expect(await t.check(0, authoritative)).toEqual({ allowed: true });
    await runDurableObjectAlarm(t.stub);
    expect(sent[1]).toMatchObject({ periodEnd: shorterEnd, subscriptionUnitsUsed: 2 });
    expect(await t.check(100, authoritative)).toEqual({ allowed: false, periodEnd: shorterEnd });
  });

  it.each([false, true])(
    'confirms only the submitted snapshot with concurrent rollover=%s',
    async (rollover) => {
      const { sent, fetchMock } = syncRecorder();
      const t = tracker();
      await t.check(1);
      const next = {
        ...t.config,
        currentPeriodStart: t.config.currentPeriodEnd!,
        currentPeriodEnd: t.config.currentPeriodEnd! + DAY,
      };
      await runInDurableObject(
        t.stub,
        async (instance: InstanceType<typeof UsageTracker>, state) => {
          let entered!: () => void;
          let release!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const waiting = new Promise<void>((resolve) => {
            release = resolve;
          });
          fetchMock.mockImplementationOnce(async (_input, init) => {
            sent.push(JSON.parse(String(init?.body)) as UsageSnapshot);
            entered();
            await waiting;
            return new Response(null);
          });
          await state.storage.deleteAlarm();
          const alarm = instance.alarm();
          await started;
          const check = (count: number, subscriptionConfig = t.config) =>
            instance.fetch(
              new Request('https://usage.internal/check', {
                method: 'POST',
                body: JSON.stringify({ orgId: t.orgId, count, subscriptionConfig }),
              }),
            );
          await check(2);
          if (rollover) await check(4, next);
          release();
          await alarm;
        },
      );
      if (!rollover)
        expect(await counters(t.stub)).toMatchObject({
          subscription_units_used: 3,
          last_pushed_subscription: 1,
        });
      await runDurableObjectAlarm(t.stub);
      expect(sent.map((s) => [s.periodStart, s.subscriptionUnitsUsed])).toEqual(
        rollover
          ? [
              [t.config.currentPeriodStart, 1],
              [t.config.currentPeriodStart, 3],
              [next.currentPeriodStart, 4],
            ]
          : [
              [t.config.currentPeriodStart, 1],
              [t.config.currentPeriodStart, 3],
            ],
      );
    },
  );

  it('preserves accumulated totals when an old period arrives after an authoritative advance', async () => {
    syncRecorder();
    const t = tracker();
    await t.check(1);
    const next = {
      ...t.config,
      currentPeriodStart: t.config.currentPeriodEnd!,
      currentPeriodEnd: t.config.currentPeriodEnd! + DAY,
    };
    await t.check(2, next);
    await t.check(3);
    expect(await counters(t.stub)).toMatchObject({ subscription_units_used: 5 });
  });

  it.each([-2, 2])(
    'repairs an estimated start offset by %i days without resetting usage',
    async (offset) => {
      const { sent } = syncRecorder();
      const t = tracker({
        currentPeriodStart: Date.now() - 40 * DAY,
        currentPeriodEnd: Date.now() - 10 * DAY,
      });
      await t.check(13);
      await runDurableObjectAlarm(t.stub);
      const estimated = sent[0]!;
      const authoritative = {
        ...t.config,
        currentPeriodStart: estimated.periodStart + offset * DAY,
        currentPeriodEnd: estimated.periodEnd + offset * DAY,
      };
      expect(await t.check(1, authoritative)).toEqual({ allowed: true });
      expect(await t.check(2, authoritative)).toMatchObject({ allowed: false });
      expect(await t.check(0)).toEqual({ allowed: true });
      await evictDurableObject(t.stub);
      await runDurableObjectAlarm(t.stub);
      expect(sent[1]).toMatchObject({
        periodStart: authoritative.currentPeriodStart,
        periodEnd: authoritative.currentPeriodEnd,
        subscriptionUnitsUsed: 10,
        addonUnitsUsed: 4,
      });
      expect(await counters(t.stub)).toMatchObject({
        subscription_units_used: 10,
        addon_units_used: 4,
      });
    },
  );

  it('preserves final totals and lifetime addon consumption on a clock-driven rollover', async () => {
    const { sent } = syncRecorder();
    const t = tracker();
    await t.check(13);
    vi.spyOn(Date, 'now').mockReturnValue(t.config.currentPeriodEnd! + 1);
    expect(await t.check(11)).toEqual({ allowed: true });
    expect(await t.check(2)).toMatchObject({ allowed: false });
    await runDurableObjectAlarm(t.stub);
    expect(sent.map((s) => [s.periodStart, s.subscriptionUnitsUsed, s.addonUnitsUsed])).toEqual([
      [t.config.currentPeriodStart, 10, 3],
      [t.config.currentPeriodEnd, 10, 1],
    ]);
  });

  it.each([
    { confirmed: false, startOffset: 0 },
    { confirmed: true, startOffset: 0 },
    { confirmed: false, startOffset: -DAY },
    { confirmed: true, startOffset: -DAY },
  ])(
    'keeps older extended periods separate after rollover: %j',
    async ({ confirmed, startOffset }) => {
      const { sent } = syncRecorder();
      const t = tracker();
      await t.check(13);
      if (confirmed) await runDurableObjectAlarm(t.stub);
      const duration = t.config.currentPeriodEnd! - t.config.currentPeriodStart!;
      vi.spyOn(Date, 'now').mockReturnValue(t.config.currentPeriodEnd! + 1);
      await t.check(11);
      await evictDurableObject(t.stub);
      const extension = {
        ...t.config,
        currentPeriodStart: t.config.currentPeriodStart! + startOffset,
        currentPeriodEnd: t.config.currentPeriodEnd! + duration,
      };
      expect(await t.check(0, extension)).toEqual({ allowed: true });
      expect(await t.check(2, extension)).toMatchObject({ allowed: false });
      expect(await t.check(1, extension)).toEqual({ allowed: true });
      expect(await t.check(1, extension)).toMatchObject({ allowed: false });
      await runDurableObjectAlarm(t.stub);
      expect(sent.map((s) => [s.periodStart, s.subscriptionUnitsUsed, s.addonUnitsUsed])).toEqual([
        [t.config.currentPeriodStart, 10, 3],
        [t.config.currentPeriodEnd, 10, 2],
      ]);
      expect(await runDurableObjectAlarm(t.stub)).toBe(false);
    },
  );

  it('replaces an unconfirmed estimate with the real period instead of pushing both', async () => {
    const { sent, fetchMock } = syncRecorder(503);
    const t = tracker({
      currentPeriodStart: Date.now() - 40 * DAY,
      currentPeriodEnd: Date.now() - 10 * DAY,
    });
    await t.check(3);
    await runDurableObjectAlarm(t.stub);
    const estimate = sent[0]!;
    const actual = {
      ...t.config,
      currentPeriodStart: estimate.periodStart - DAY,
      currentPeriodEnd: estimate.periodEnd - DAY,
    };
    await t.check(1, actual);
    fetchMock.mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as UsageSnapshot);
      return new Response(null);
    });
    await runDurableObjectAlarm(t.stub);
    expect(sent.slice(1)).toEqual([
      expect.objectContaining({ periodStart: actual.currentPeriodStart, subscriptionUnitsUsed: 4 }),
    ]);
    expect(await runDurableObjectAlarm(t.stub)).toBe(false);
  });

  it('atomically enforces the shared allowance across concurrent requests', async () => {
    const t = tracker();
    const results = await Promise.all(Array.from({ length: 30 }, () => t.check(1)));
    expect(results.filter((r) => r.allowed)).toHaveLength(15);
    expect(await counters(t.stub)).toMatchObject({
      subscription_units_used: 10,
      addon_units_used: 5,
    });
  });

  it('rejects tenant mismatch and invalid quantities without consuming usage', async () => {
    const t = tracker();
    await t.check(1);
    await expect(
      t.stub.fetch('https://usage.internal/check', {
        method: 'POST',
        body: JSON.stringify({ orgId: 'other-org', count: 1, subscriptionConfig: t.config }),
      }),
    ).rejects.toThrow('Usage organization mismatch');
    await expect(t.check(-1)).rejects.toThrow('Invalid usage configuration');
    expect(await counters(t.stub)).toMatchObject({ subscription_units_used: 1 });
  });
});
