import { describe, it, expect, vi } from 'vitest';
import { createOrgWithDefaultBilling, ensureOrgHasSubscription } from '../auth/organizations';
import { TIER_CONFIG } from '@trace-flow/types';

// ---------------------------------------------------------------------------
// createOrgWithDefaultBilling
// ---------------------------------------------------------------------------

describe('createOrgWithDefaultBilling', () => {
  function makeBootstrapCtx() {
    const dbInsert = vi.fn().mockImplementation((table: string, _doc: Record<string, unknown>) => {
      if (table === 'organizations') return Promise.resolve('org_new' as any);
      if (table === 'organizationMembers') return Promise.resolve('member_new' as any);
      if (table === 'subscriptions') return Promise.resolve('sub_new' as any);
      return Promise.resolve('id' as any);
    });
    const dbPatch = vi.fn().mockResolvedValue(undefined);
    const schedulerRunAfter = vi.fn().mockResolvedValue('scheduler_id');

    return {
      db: {
        insert: dbInsert,
        patch: dbPatch,
        query: vi.fn().mockReturnValue({
          withIndex: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        }),
      },
      scheduler: { runAfter: schedulerRunAfter },
      _dbInsert: dbInsert,
      _dbPatch: dbPatch,
      _schedulerRunAfter: schedulerRunAfter,
    };
  }

  it('creates org, membership, subscription and schedules KV syncs', async () => {
    const ctx = makeBootstrapCtx() as any;
    const userId = 'user_1' as any;

    const orgId = await createOrgWithDefaultBilling(ctx, userId, 'Alice', 'auth0|123');

    expect(orgId).toBe('org_new');
    expect(ctx._dbInsert).toHaveBeenCalledWith(
      'organizations',
      expect.objectContaining({
        name: "Alice's Org",
        ownerId: userId,
      }),
    );
    expect(ctx._dbPatch).toHaveBeenCalledWith(userId, { orgId: 'org_new' });
    expect(ctx._dbInsert).toHaveBeenCalledWith(
      'organizationMembers',
      expect.objectContaining({
        orgId: 'org_new',
        userId,
        role: 'owner',
        status: 'active',
      }),
    );
    expect(ctx._dbInsert).toHaveBeenCalledWith(
      'subscriptions',
      expect.objectContaining({
        orgId: 'org_new',
        tier: 'hobby',
        status: 'active',
        monthlyUnits: TIER_CONFIG.hobby.monthlyUnits,
      }),
    );
    expect(ctx._schedulerRunAfter).toHaveBeenCalledTimes(2);
    const calls = ctx._schedulerRunAfter.mock.calls;
    const userOrgSync = calls.find(
      (c: unknown[]) =>
        c[2] && typeof c[2] === 'object' && 'sub' in (c[2] as Record<string, unknown>),
    );
    expect(userOrgSync).toBeDefined();
    const args = (userOrgSync as [number, unknown, Record<string, unknown>])[2];
    expect(args.sub).toBe('auth0|123');
    expect(args.orgId).toBe('org_new');
  });

  it('uses default org name when name not provided', async () => {
    const ctx = makeBootstrapCtx() as any;
    const userId = 'user_1' as any;

    await createOrgWithDefaultBilling(ctx, userId);

    expect(ctx._dbInsert).toHaveBeenCalledWith(
      'organizations',
      expect.objectContaining({
        name: 'My Organization',
      }),
    );
  });

  it('does not schedule user-org KV sync when sub not provided', async () => {
    const ctx = makeBootstrapCtx() as any;
    const userId = 'user_1' as any;

    await createOrgWithDefaultBilling(ctx, userId, 'Bob');

    expect(ctx._schedulerRunAfter).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ensureOrgHasSubscription
// ---------------------------------------------------------------------------

describe('ensureOrgHasSubscription', () => {
  it('creates hobby subscription when none exists', async () => {
    const dbInsert = vi.fn().mockResolvedValue('sub_new' as any);
    const schedulerRunAfter = vi.fn().mockResolvedValue('scheduler_id');
    const ctx = {
      db: {
        insert: dbInsert,
        query: vi.fn().mockReturnValue({
          withIndex: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        }),
      },
      scheduler: { runAfter: schedulerRunAfter },
    } as any;
    const orgId = 'org_1' as any;

    await ensureOrgHasSubscription(ctx, orgId);

    expect(dbInsert).toHaveBeenCalledWith('subscriptions', expect.any(Object));
    expect(dbInsert.mock.calls[0][1]).toMatchObject({
      orgId,
      tier: 'hobby',
      status: 'active',
      monthlyUnits: TIER_CONFIG.hobby.monthlyUnits,
    });
    expect(dbInsert.mock.calls[0][1]).not.toHaveProperty('seatQuantity');
    expect(schedulerRunAfter).toHaveBeenCalledTimes(1);
    expect(schedulerRunAfter.mock.calls[0][2]).toMatchObject({
      orgId,
      tier: 'hobby',
      autoOverage: false,
    });
  });

  it('is idempotent when subscription already exists', async () => {
    const existingSub = { _id: 'sub_1', orgId: 'org_1', tier: 'hobby' };
    const dbInsert = vi.fn().mockResolvedValue('sub_new' as any);
    const schedulerRunAfter = vi.fn().mockResolvedValue('scheduler_id');
    const ctx = {
      db: {
        insert: dbInsert,
        query: vi.fn().mockReturnValue({
          withIndex: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(existingSub),
        }),
      },
      scheduler: { runAfter: schedulerRunAfter },
    } as any;
    const orgId = 'org_1' as any;

    await ensureOrgHasSubscription(ctx, orgId);

    expect(dbInsert).not.toHaveBeenCalled();
    expect(schedulerRunAfter).not.toHaveBeenCalled();
  });
});
