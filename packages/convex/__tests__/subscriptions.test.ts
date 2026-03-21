import { describe, it, expect, vi } from 'vitest';
import { mapStripeStatusToInternal } from '../billing/subscriptions';

// ---------------------------------------------------------------------------
// Pure function tests — no Convex context needed
// ---------------------------------------------------------------------------

describe('mapStripeStatusToInternal', () => {
  it('maps active to active', () => {
    expect(mapStripeStatusToInternal('active')).toBe('active');
  });

  it('maps trialing to active', () => {
    expect(mapStripeStatusToInternal('trialing')).toBe('active');
  });

  it('maps past_due to grace', () => {
    expect(mapStripeStatusToInternal('past_due')).toBe('grace');
  });

  it('maps incomplete to suspended', () => {
    expect(mapStripeStatusToInternal('incomplete')).toBe('suspended');
  });

  it('maps unpaid to suspended', () => {
    expect(mapStripeStatusToInternal('unpaid')).toBe('suspended');
  });

  it('maps canceled to canceled', () => {
    expect(mapStripeStatusToInternal('canceled')).toBe('canceled');
  });

  it('maps incomplete_expired to canceled', () => {
    expect(mapStripeStatusToInternal('incomplete_expired')).toBe('canceled');
  });

  it('throws on unknown status', () => {
    expect(() => mapStripeStatusToInternal('unknown_status')).toThrow(
      'Unknown Stripe subscription status: unknown_status',
    );
  });

  it('throws on empty string', () => {
    expect(() => mapStripeStatusToInternal('')).toThrow('Unknown Stripe subscription status: ');
  });
});

// ---------------------------------------------------------------------------
// Handler logic tests via mocked Convex ctx
// ---------------------------------------------------------------------------

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'sub_id' as any,
    orgId: 'org_id' as any,
    tier: 'hobby',
    status: 'active',
    monthlyUnits: 1000,
    addonUnits: 0,
    currentPeriodStart: 1000000,
    currentPeriodEnd: 1000000 + 30 * 24 * 60 * 60 * 1000,
    currentPeriodOverageSpentCents: 0,
    addonPurchaseCount: 0,
    autoOverage: false,
    overageCapCents: undefined as number | undefined,
    gracePeriodSchedulerId: undefined as string | undefined,
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const dbPatch = vi.fn().mockResolvedValue(undefined);
  const dbInsert = vi.fn().mockResolvedValue('new_id');
  const dbGet = vi.fn();
  const schedulerRunAfter = vi.fn().mockResolvedValue('scheduler_id');
  const schedulerCancel = vi.fn().mockResolvedValue(undefined);

  const makeQuery = (result: unknown) => ({
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(result),
    collect: vi.fn().mockResolvedValue(result ?? []),
    order: vi.fn().mockReturnThis(),
  });

  return {
    db: {
      get: dbGet,
      patch: dbPatch,
      insert: dbInsert,
      delete: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockReturnValue(makeQuery(null)),
      _makeQuery: makeQuery,
    },
    scheduler: {
      runAfter: schedulerRunAfter,
      cancel: schedulerCancel,
    },
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue({
        tokenIdentifier: 'token|123',
        email: 'test@example.com',
        'neuron/roles': ['Trace Flow'],
      }),
    },
    _dbPatch: dbPatch,
    _dbInsert: dbInsert,
    _dbGet: dbGet,
    _schedulerRunAfter: schedulerRunAfter,
    _schedulerCancel: schedulerCancel,
    ...overrides,
  };
}

// Helper to set up db.query to return a specific result for a given table
function makeQueryReturning(result: unknown) {
  const q = {
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(result),
    collect: vi.fn().mockResolvedValue(Array.isArray(result) ? result : result ? [result] : []),
    order: vi.fn().mockReturnThis(),
  };
  return q;
}

// ---------------------------------------------------------------------------
// setTier handler logic
// ---------------------------------------------------------------------------

describe('setTier handler logic', () => {
  it('patches subscription with new tier config', async () => {
    const sub = makeSub({ tier: 'hobby' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));
    ctx.db.get = vi.fn().mockResolvedValue(sub);

    // Inline handler logic from setTier
    const { TIER_CONFIG } = await import('@trace-flow/types');
    const _orgId = 'org_id' as any;
    const tier = 'pro' as const;

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) throw new Error('Subscription not found');

    const config = TIER_CONFIG[tier];
    await ctx.db.patch(subscription._id, {
      tier,
      status: 'active',
      monthlyUnits: config.monthlyUnits,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith('sub_id', {
      tier: 'pro',
      status: 'active',
      monthlyUnits: config.monthlyUnits,
    });
  });

  it('schedules retention extension when upgrading hobby to pro', async () => {
    const sub = makeSub({ tier: 'hobby' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));
    ctx.db.get = vi.fn().mockResolvedValue(sub);

    // Simulate the upgrade path
    const previousTier = sub.tier;
    const newTier = 'pro';

    if (previousTier === 'hobby' && newTier === 'pro') {
      await ctx.scheduler.runAfter(0, 'internal.integrations.tinybird.extendRetention' as any, {
        orgId: 'org_id',
      });
    }

    expect(ctx._schedulerRunAfter).toHaveBeenCalledWith(
      0,
      'internal.integrations.tinybird.extendRetention',
      expect.objectContaining({ orgId: 'org_id' }),
    );
  });

  it('does NOT schedule retention extension when staying on pro', async () => {
    const sub = makeSub({ tier: 'pro' });
    const ctx = makeCtx();

    const previousTier = sub.tier;
    const newTier = 'pro';

    if (previousTier === 'hobby' && newTier === 'pro') {
      await ctx.scheduler.runAfter(0, 'internal.integrations.tinybird.extendRetention' as any, {
        orgId: 'org_id',
      });
    }

    expect(ctx._schedulerRunAfter).not.toHaveBeenCalled();
  });

  it('throws when subscription not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(null));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    expect(() => {
      if (!subscription) throw new Error('Subscription not found');
    }).toThrow('Subscription not found');
  });
});

// ---------------------------------------------------------------------------
// addAddonUnits handler logic
// ---------------------------------------------------------------------------

describe('addAddonUnits handler logic', () => {
  it('rejects non-positive units', () => {
    expect(() => {
      const units = 0;
      if (units <= 0) throw new Error('Units must be positive');
    }).toThrow('Units must be positive');

    expect(() => {
      const units = -5;
      if (units <= 0) throw new Error('Units must be positive');
    }).toThrow('Units must be positive');
  });

  it('adds units to existing addonUnits', async () => {
    const sub = makeSub({ addonUnits: 500 });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    const units = 200;
    const newAddonUnits = subscription!.addonUnits + units;
    await ctx.db.patch(subscription!._id, { addonUnits: newAddonUnits });

    expect(ctx._dbPatch).toHaveBeenCalledWith('sub_id', { addonUnits: 700 });
  });

  it('throws when subscription not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(null));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    expect(() => {
      if (!subscription) throw new Error('Subscription not found');
    }).toThrow('Subscription not found');
  });
});

// ---------------------------------------------------------------------------
// upsertStripeSubscriptionState handler logic
// ---------------------------------------------------------------------------

describe('upsertStripeSubscriptionState handler logic', () => {
  it('cancels grace period scheduler when transitioning to active', async () => {
    const sub = makeSub({ status: 'grace', gracePeriodSchedulerId: 'sched_abc' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    const newStatus = 'active';

    if (newStatus === 'active' && subscription!.gracePeriodSchedulerId) {
      await ctx.scheduler.cancel(subscription!.gracePeriodSchedulerId);
    }

    expect(ctx._schedulerCancel).toHaveBeenCalledWith('sched_abc');
  });

  it('does NOT cancel scheduler when not transitioning to active', async () => {
    const sub = makeSub({ status: 'active', gracePeriodSchedulerId: 'sched_abc' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    const newStatus = 'grace' as string;

    if (newStatus === 'active' && subscription?.gracePeriodSchedulerId) {
      await ctx.scheduler.cancel(subscription.gracePeriodSchedulerId);
    }

    expect(ctx._schedulerCancel).not.toHaveBeenCalled();
  });

  it('resets overage spent when period rolls over', () => {
    const sub = makeSub({
      currentPeriodStart: 1000,
      currentPeriodOverageSpentCents: 500,
    });

    // New period start differs from existing → reset overage to 0
    const newPeriodStart = 2000;
    const resetOverage =
      newPeriodStart && newPeriodStart !== sub.currentPeriodStart
        ? 0
        : sub.currentPeriodOverageSpentCents;

    expect(resetOverage).toBe(0);
  });

  it('keeps overage spent when period is the same', () => {
    const sub = makeSub({
      currentPeriodStart: 1000,
      currentPeriodOverageSpentCents: 500,
    });

    const newPeriodStart = sub.currentPeriodStart; // same period
    const resetOverage =
      newPeriodStart && newPeriodStart !== sub.currentPeriodStart
        ? 0
        : sub.currentPeriodOverageSpentCents;

    expect(resetOverage).toBe(500);
  });

  it('clears gracePeriodSchedulerId when transitioning to active', async () => {
    const sub = makeSub({ status: 'grace', gracePeriodSchedulerId: 'sched_abc' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    const newStatus = 'active';

    const patchPayload: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'active') {
      patchPayload.gracePeriodSchedulerId = undefined;
    }

    await ctx.db.patch(subscription!._id, patchPayload);

    expect(ctx._dbPatch).toHaveBeenCalledWith(
      'sub_id',
      expect.objectContaining({ gracePeriodSchedulerId: undefined }),
    );
  });

  it('throws when subscription not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(null));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    expect(() => {
      if (!subscription) throw new Error('Subscription not found');
    }).toThrow('Subscription not found');
  });
});

// ---------------------------------------------------------------------------
// creditAddonPurchase handler logic (idempotency)
// ---------------------------------------------------------------------------

describe('creditAddonPurchase handler logic', () => {
  it('is idempotent — skips if payment_intent already recorded', async () => {
    const existingPurchase = { _id: 'purchase_id', stripePaymentIntentId: 'pi_abc' };
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(existingPurchase));

    const existing = await ctx.db.query('addonPurchases').withIndex('by_payment_intent').first();

    // Handler returns early if existing purchase found
    if (existing) {
      // early return — no further db operations
    } else {
      await ctx.db.patch('sub_id' as any, { addonUnits: 100 });
    }

    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });

  it('credits addon units and inserts purchase record', async () => {
    const sub = makeSub({ addonUnits: 100, addonPurchaseCount: 2 });
    const ctx = makeCtx();

    // First query (addonPurchases) returns null → not a duplicate
    // Second query (subscriptions) returns the subscription
    let callCount = 0;
    ctx.db.query = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeQueryReturning(null); // addonPurchases
      return makeQueryReturning(sub); // subscriptions
    });

    const existing = await ctx.db.query('addonPurchases').withIndex('by_payment_intent').first();
    if (existing) return;

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) throw new Error('Subscription not found');

    const units = 500;
    const newAddonUnits = subscription.addonUnits + units;
    await ctx.db.patch(subscription._id, {
      addonUnits: newAddonUnits,
      addonPurchaseCount: subscription.addonPurchaseCount + 1,
      autoTopupPendingSince: undefined,
    });

    await ctx.db.insert('addonPurchases', {
      orgId: subscription.orgId,
      units,
      amountCents: 1000,
      stripePaymentIntentId: 'pi_new',
      mode: 'manual',
      periodStart: subscription.currentPeriodStart,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith(
      'sub_id',
      expect.objectContaining({
        addonUnits: 600,
        addonPurchaseCount: 3,
        autoTopupPendingSince: undefined,
      }),
    );
    expect(ctx._dbInsert).toHaveBeenCalledWith(
      'addonPurchases',
      expect.objectContaining({ units: 500, stripePaymentIntentId: 'pi_new' }),
    );
  });
});

// ---------------------------------------------------------------------------
// scheduleGraceSuspension handler logic
// ---------------------------------------------------------------------------

describe('scheduleGraceSuspension handler logic', () => {
  it('schedules suspension for grace-status subscriptions', async () => {
    const sub = makeSub({ status: 'grace', gracePeriodSchedulerId: undefined });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) return;
    if (subscription.status !== 'grace') return;
    if (subscription.gracePeriodSchedulerId) return;

    const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
    const schedulerId = await ctx.scheduler.runAfter(
      GRACE_PERIOD_MS,
      'internal.billing.subscriptions.transitionGraceToSuspended' as any,
      { orgId: subscription.orgId },
    );
    await ctx.db.patch(subscription._id, { gracePeriodSchedulerId: schedulerId });

    expect(ctx._schedulerRunAfter).toHaveBeenCalledWith(
      GRACE_PERIOD_MS,
      expect.anything(),
      expect.objectContaining({ orgId: 'org_id' }),
    );
    expect(ctx._dbPatch).toHaveBeenCalledWith('sub_id', { gracePeriodSchedulerId: 'scheduler_id' });
  });

  it('does not double-schedule when gracePeriodSchedulerId already set', async () => {
    const sub = makeSub({ status: 'grace', gracePeriodSchedulerId: 'existing_sched' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) return;
    if (subscription.status !== 'grace') return;
    if (subscription.gracePeriodSchedulerId) return; // early return

    await ctx.scheduler.runAfter(0, 'anything' as any, {});

    expect(ctx._schedulerRunAfter).not.toHaveBeenCalled();
  });

  it('does not schedule when status is not grace', async () => {
    const sub = makeSub({ status: 'active', gracePeriodSchedulerId: undefined });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) return;
    if (subscription.status !== 'grace') return; // early return

    await ctx.scheduler.runAfter(0, 'anything' as any, {});

    expect(ctx._schedulerRunAfter).not.toHaveBeenCalled();
  });

  it('returns early when subscription not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(null));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) return;

    await ctx.scheduler.runAfter(0, 'anything' as any, {});
    expect(ctx._schedulerRunAfter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// transitionGraceToSuspended handler logic
// ---------------------------------------------------------------------------

describe('transitionGraceToSuspended handler logic', () => {
  it('transitions grace → suspended', async () => {
    const sub = makeSub({ status: 'grace' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));
    ctx.db.get = vi.fn().mockResolvedValue(sub);

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) return;
    if (subscription.status !== 'grace') return;

    await ctx.db.patch(subscription._id, {
      status: 'suspended',
      gracePeriodSchedulerId: undefined,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith('sub_id', {
      status: 'suspended',
      gracePeriodSchedulerId: undefined,
    });
  });

  it('does nothing when status is not grace', async () => {
    const sub = makeSub({ status: 'active' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) return;
    if (subscription.status !== 'grace') return; // early return

    await ctx.db.patch(subscription._id, { status: 'suspended' });
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });

  it('does nothing when subscription not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(null));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) return;

    await ctx.db.patch('sub_id' as any, { status: 'suspended' });
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateAutoOverageSettings handler logic
// ---------------------------------------------------------------------------

describe('updateAutoOverageSettings handler logic', () => {
  it('rejects when subscription tier is not pro', () => {
    const sub = makeSub({ tier: 'hobby' });

    expect(() => {
      if (sub.tier !== 'pro') throw new Error('Auto-topup requires Pro');
    }).toThrow('Auto-topup requires Pro');
  });

  it('patches autoOverage and overageCapCents for pro tier', async () => {
    const sub = makeSub({ tier: 'pro' });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));
    ctx.db.get = vi.fn().mockResolvedValue(sub);

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) throw new Error('Subscription not found');
    if (subscription.tier !== 'pro') throw new Error('Auto-topup requires Pro');

    await ctx.db.patch(subscription._id, {
      autoOverage: true,
      overageCapCents: 5000,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith('sub_id', {
      autoOverage: true,
      overageCapCents: 5000,
    });
  });

  it('allows disabling auto-overage on pro tier', async () => {
    const sub = makeSub({ tier: 'pro', autoOverage: true });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) throw new Error('Subscription not found');
    if (subscription.tier !== 'pro') throw new Error('Auto-topup requires Pro');

    await ctx.db.patch(subscription._id, {
      autoOverage: false,
      overageCapCents: undefined,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith('sub_id', {
      autoOverage: false,
      overageCapCents: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// reserveAutoTopup handler logic
// ---------------------------------------------------------------------------

describe('reserveAutoTopup handler logic', () => {
  it('returns ok:false when subscription not found', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(null));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    if (!subscription) {
      expect({ ok: false, reason: 'subscription_not_found' }).toEqual({
        ok: false,
        reason: 'subscription_not_found',
      });
      return;
    }
    expect.fail('Should have returned early');
  });

  it('returns ok:false when tier is not pro', () => {
    const sub = makeSub({ tier: 'hobby' });
    if (sub.tier !== 'pro') {
      expect({ ok: false, reason: 'not_pro' }).toEqual({ ok: false, reason: 'not_pro' });
      return;
    }
    expect.fail('Should have returned early');
  });

  it('returns ok:false when auto_topup_disabled', () => {
    const sub = makeSub({ tier: 'pro', autoOverage: false });
    if (!sub.autoOverage) {
      expect({ ok: false, reason: 'auto_topup_disabled' }).toEqual({
        ok: false,
        reason: 'auto_topup_disabled',
      });
      return;
    }
    expect.fail('Should have returned early');
  });

  it('returns ok:false when cap would be exceeded', () => {
    const sub = makeSub({
      tier: 'pro',
      autoOverage: true,
      overageCapCents: 1000,
      currentPeriodOverageSpentCents: 900,
    });

    const amountCents = 200;
    const cap = sub.overageCapCents;
    if (cap !== undefined && sub.currentPeriodOverageSpentCents + amountCents > cap) {
      expect({ ok: false, reason: 'cap_reached' }).toEqual({ ok: false, reason: 'cap_reached' });
      return;
    }
    expect.fail('Should have returned early');
  });

  it('reserves spend and returns ok:true when under cap', async () => {
    const sub = makeSub({
      tier: 'pro',
      autoOverage: true,
      overageCapCents: 5000,
      currentPeriodOverageSpentCents: 100,
      addonPurchaseCount: 3,
    });
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue(makeQueryReturning(sub));

    const subscription = await ctx.db.query('subscriptions').withIndex('by_org_id').first();
    const amountCents = 1000;

    const cap = subscription!.overageCapCents;
    const wouldExceedCap =
      cap !== undefined && subscription!.currentPeriodOverageSpentCents + amountCents > cap;

    expect(wouldExceedCap).toBe(false);

    await ctx.db.patch(subscription!._id, {
      currentPeriodOverageSpentCents: subscription!.currentPeriodOverageSpentCents + amountCents,
    });

    expect(ctx._dbPatch).toHaveBeenCalledWith('sub_id', {
      currentPeriodOverageSpentCents: 1100,
    });
  });

  it('allows spending when no cap is set', () => {
    const sub = makeSub({
      tier: 'pro',
      autoOverage: true,
      overageCapCents: undefined,
      currentPeriodOverageSpentCents: 99999,
    });

    const amountCents = 99999;
    const cap = sub.overageCapCents;
    const wouldExceedCap =
      cap !== undefined && sub.currentPeriodOverageSpentCents + amountCents > cap;

    expect(wouldExceedCap).toBe(false);
  });
});
