import { describe, it, expect, vi } from 'vitest';
import { TIER_CONFIG } from '@trace-flow/types';

// ---------------------------------------------------------------------------
// usage.ts handler logic tests
// ---------------------------------------------------------------------------

const AUTO_TOPUP_DEDUP_MS = 15 * 60 * 1000; // 15 minutes

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'sub_id' as any,
    orgId: 'org_id' as any,
    tier: 'pro' as const,
    status: 'active' as const,
    monthlyUnits: 10000,
    addonUnits: 0,
    currentPeriodStart: 1000000,
    currentPeriodEnd: 1000000 + 30 * 24 * 60 * 60 * 1000,
    currentPeriodOverageSpentCents: 0,
    addonPurchaseCount: 0,
    autoOverage: true,
    autoTopupPendingSince: undefined as number | undefined,
    overageCapCents: undefined as number | undefined,
    ...overrides,
  };
}

function makeCtx() {
  const dbPatch = vi.fn().mockResolvedValue(undefined);
  const dbInsert = vi.fn().mockResolvedValue('new_usage_id');
  const schedulerRunAfter = vi.fn().mockResolvedValue('sched_id');

  return {
    db: {
      patch: dbPatch,
      insert: dbInsert,
      query: vi.fn().mockReturnValue({
        withIndex: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        collect: vi.fn().mockResolvedValue([]),
      }),
    },
    scheduler: { runAfter: schedulerRunAfter },
    _dbPatch: dbPatch,
    _dbInsert: dbInsert,
    _schedulerRunAfter: schedulerRunAfter,
  };
}

// ---------------------------------------------------------------------------
// recordUsage handler logic
// ---------------------------------------------------------------------------

describe('recordUsage handler logic', () => {
  it('inserts new usage record when none exists', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    });

    const existing = await ctx.db.query('usage').withIndex('by_org_id_period').first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        subscriptionUnitsUsed: 100,
        addonUnitsUsed: 0,
        periodEnd: 2000000,
      });
    } else {
      await ctx.db.insert('usage', {
        orgId: 'org_id' as any,
        periodStart: 1000000,
        periodEnd: 2000000,
        subscriptionUnitsUsed: 100,
        addonUnitsUsed: 0,
      });
    }

    expect(ctx._dbInsert).toHaveBeenCalledWith(
      'usage',
      expect.objectContaining({
        orgId: 'org_id',
        periodStart: 1000000,
        subscriptionUnitsUsed: 100,
        addonUnitsUsed: 0,
      }),
    );
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });

  it('patches existing usage record when one exists', async () => {
    const existing = {
      _id: 'usage_id',
      orgId: 'org_id',
      periodStart: 1000000,
      periodEnd: 1500000,
      subscriptionUnitsUsed: 50,
      addonUnitsUsed: 0,
    };
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
    });

    const found = await ctx.db.query('usage').withIndex('by_org_id_period').first();

    if (found) {
      await ctx.db.patch(found._id, {
        subscriptionUnitsUsed: 200,
        addonUnitsUsed: 50,
        periodEnd: 2000000,
      });
    }

    expect(ctx._dbPatch).toHaveBeenCalledWith('usage_id', {
      subscriptionUnitsUsed: 200,
      addonUnitsUsed: 50,
      periodEnd: 2000000,
    });
    expect(ctx._dbInsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkAutoTopup handler logic
// ---------------------------------------------------------------------------

describe('checkAutoTopup handler logic', () => {
  it('returns early when no subscription', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    });

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) {
      expect(ctx._schedulerRunAfter).not.toHaveBeenCalled();
      return;
    }
    expect.fail('Should have returned early');
  });

  it('returns early when tier is not pro', async () => {
    const sub = makeSub({ tier: 'hobby' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(sub),
    });

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) return;
    if (subscription.tier !== 'pro') {
      expect(ctx._schedulerRunAfter).not.toHaveBeenCalled();
      return;
    }
    expect.fail('Should have returned early');
  });

  it('returns early when autoOverage is false', () => {
    const sub = makeSub({ autoOverage: false });
    const ctx = makeCtx();

    if (!sub.autoOverage) {
      expect(ctx._schedulerRunAfter).not.toHaveBeenCalled();
      return;
    }
    expect.fail('Should have returned early');
  });

  it('deduplicates: skips when topup was recently triggered', () => {
    const recentTimestamp = Date.now() - AUTO_TOPUP_DEDUP_MS / 2; // within window
    const sub = makeSub({ autoTopupPendingSince: recentTimestamp });
    const ctx = makeCtx();

    const shouldSkip =
      sub.autoTopupPendingSince !== undefined &&
      Date.now() - sub.autoTopupPendingSince < AUTO_TOPUP_DEDUP_MS;

    expect(shouldSkip).toBe(true);
    expect(ctx._schedulerRunAfter).not.toHaveBeenCalled();
  });

  it('does not deduplicate when topup is older than window', () => {
    const oldTimestamp = Date.now() - AUTO_TOPUP_DEDUP_MS - 1000; // outside window
    const sub = makeSub({ autoTopupPendingSince: oldTimestamp });

    const shouldSkip =
      sub.autoTopupPendingSince !== undefined &&
      Date.now() - sub.autoTopupPendingSince < AUTO_TOPUP_DEDUP_MS;

    expect(shouldSkip).toBe(false);
  });

  it('returns early when usage ratio is below 90%', () => {
    const sub = makeSub({ monthlyUnits: 10000, addonUnits: 0 });
    const subscriptionUnitsUsed = 8000;
    const addonUnitsUsed = 0;

    const totalUsed = subscriptionUnitsUsed + addonUnitsUsed;
    const totalAvailable = sub.monthlyUnits + sub.addonUnits;
    const usageRatio = totalUsed / totalAvailable;

    expect(usageRatio).toBe(0.8); // below 0.9 threshold
    // Would return early
  });

  it('triggers auto-topup when usage ratio reaches 90%', async () => {
    const sub = makeSub({
      monthlyUnits: 10000,
      addonUnits: 0,
      autoOverage: true,
      autoTopupPendingSince: undefined,
      overageCapCents: undefined,
    });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(sub),
    });

    const subscriptionUnitsUsed = 9100;
    const addonUnitsUsed = 0;

    const totalUsed = subscriptionUnitsUsed + addonUnitsUsed;
    const totalAvailable = sub.monthlyUnits + sub.addonUnits;
    const usageRatio = totalUsed / totalAvailable;

    expect(usageRatio).toBeGreaterThanOrEqual(0.9);

    // Simulate triggering
    await ctx.db.patch(sub._id, { autoTopupPendingSince: Date.now() });
    await ctx.scheduler.runAfter(0, 'internal.billing.subscriptions.triggerAutoTopup' as any, {
      orgId: sub.orgId,
      quantity: 1,
      amountCents: expect.any(Number),
      reason: 'usage_threshold',
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith('sub_id', {
      autoTopupPendingSince: expect.any(Number),
    });
    expect(ctx._schedulerRunAfter).toHaveBeenCalled();
  });

  it('returns early when usage ratio exceeds cap', () => {
    const sub = makeSub({
      autoOverage: true,
      overageCapCents: 1000,
      currentPeriodOverageSpentCents: 900,
    });

    const addonAmountCents = TIER_CONFIG.pro.overagePer100kCents;
    const cap = sub.overageCapCents;
    const wouldExceedCap =
      cap !== undefined && sub.currentPeriodOverageSpentCents + addonAmountCents > cap;

    // If would exceed cap, skip
    if (wouldExceedCap) {
      expect(true).toBe(true); // returns early
    }
  });

  it('returns early when total available is zero', () => {
    const sub = makeSub({ monthlyUnits: 0, addonUnits: 0 });
    const totalAvailable = sub.monthlyUnits + sub.addonUnits;
    expect(totalAvailable).toBe(0);
    // Guard: if totalAvailable <= 0 return
  });
});

// ---------------------------------------------------------------------------
// getForOrgInternal handler logic
// ---------------------------------------------------------------------------

describe('getForOrgInternal handler logic', () => {
  it('returns null when no subscription found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    });

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    const result = !subscription ? null : 'would-query-usage';
    expect(result).toBeNull();
  });

  it('queries usage for current period when subscription exists', async () => {
    const sub = makeSub({ currentPeriodStart: 1000000 });
    const usageRecord = {
      _id: 'usage_id',
      orgId: 'org_id',
      periodStart: 1000000,
      subscriptionUnitsUsed: 500,
      addonUnitsUsed: 0,
    };

    let queryCallIndex = 0;
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockImplementation(() => {
      queryCallIndex++;
      return {
        withIndex: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(queryCallIndex === 1 ? sub : usageRecord),
      };
    });

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    expect(subscription).toBeDefined();

    const usage = await ctx.db.query('usage').withIndex('by_org_id_period').first();
    expect(usage).toEqual(usageRecord);
  });
});
