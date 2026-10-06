import { describe, expect, it } from 'vitest';
import { internal } from '../_generated/api';
import { initConvexTest } from './convexTest.setup';

async function seedOrg(t: ReturnType<typeof initConvexTest>) {
  return t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      tokenIdentifier: 'usage-test',
      email: 'usage@example.com',
      enabled: true,
    });
    return ctx.db.insert('organizations', { name: 'Usage test', ownerId });
  });
}

describe('billing usage snapshots', () => {
  it('keeps the largest confirmed totals when snapshots arrive out of order', async () => {
    const t = initConvexTest();
    const orgId = await seedOrg(t);
    const first = {
      orgId,
      periodStart: 1_000,
      periodEnd: 2_000,
      subscriptionUnitsUsed: 10,
      addonUnitsUsed: 4,
    };
    await t.mutation(internal.billing.usage.recordUsage, first);
    await t.mutation(internal.billing.usage.recordUsage, {
      ...first,
      periodEnd: 1_500,
      subscriptionUnitsUsed: 2,
      addonUnitsUsed: 1,
    });
    await t.mutation(internal.billing.usage.recordUsage, {
      ...first,
      periodEnd: 1_500,
      subscriptionUnitsUsed: 12,
      addonUnitsUsed: 3,
    });
    const usage = await t.run((ctx) => ctx.db.query('usage').first());
    expect(usage).toMatchObject({ periodEnd: 1_500, subscriptionUnitsUsed: 12, addonUnitsUsed: 4 });
  });

  it('records completed and current periods independently and rejects invalid snapshots', async () => {
    const t = initConvexTest();
    const orgId = await seedOrg(t);
    const first = {
      orgId,
      periodStart: 1_000,
      periodEnd: 2_000,
      subscriptionUnitsUsed: 10,
      addonUnitsUsed: 4,
    };
    await t.mutation(internal.billing.usage.recordUsage, first);
    await t.mutation(internal.billing.usage.recordUsage, {
      ...first,
      periodStart: 2_000,
      periodEnd: 3_000,
      subscriptionUnitsUsed: 1,
      addonUnitsUsed: 0,
    });
    await expect(
      t.mutation(internal.billing.usage.recordUsage, {
        ...first,
        subscriptionUnitsUsed: -1,
      }),
    ).rejects.toThrow('Invalid usage snapshot');
    const usage = await t.run((ctx) => ctx.db.query('usage').collect());
    expect(usage.map((u) => [u.periodStart, u.subscriptionUnitsUsed, u.addonUnitsUsed])).toEqual([
      [1_000, 10, 4],
      [2_000, 1, 0],
    ]);
  });
});
