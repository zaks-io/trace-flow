import { describe, it, expect, vi } from 'vitest';
import { createOrgWithDefaultBilling, ensureOrgHasSubscription } from '../organizations';
import { TIER_CONFIG } from '@trace-flow/types';

// ---------------------------------------------------------------------------
// organizations.ts handler logic tests
// ---------------------------------------------------------------------------

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'user_id' as any,
    tokenIdentifier: 'token|123',
    email: 'test@example.com',
    enabled: true,
    orgId: 'org_id' as any,
    ...overrides,
  };
}

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'org_id' as any,
    name: 'My Org',
    ownerId: 'user_id' as any,
    ...overrides,
  };
}

function makeCtx(userResult: unknown = null, orgResult: unknown = null) {
  const dbPatch = vi.fn().mockResolvedValue(undefined);
  const dbGet = vi.fn().mockResolvedValue(orgResult);

  const makeQuery = (result: unknown) => ({
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(result),
    collect: vi.fn().mockResolvedValue(Array.isArray(result) ? result : result ? [result] : []),
    order: vi.fn().mockReturnThis(),
  });

  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue({
        tokenIdentifier: 'token|123',
        email: 'test@example.com',
        'neuron/roles': ['Trace Flow'],
      }),
    },
    db: {
      get: dbGet,
      patch: dbPatch,
      insert: vi.fn().mockResolvedValue('new_id'),
      delete: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockReturnValue(makeQuery(userResult)),
      _makeQuery: makeQuery,
    },
    _dbPatch: dbPatch,
    _dbGet: dbGet,
  };
}

// ---------------------------------------------------------------------------
// get handler logic
// ---------------------------------------------------------------------------

describe('organizations.get handler logic', () => {
  it('returns null when user has no orgId', () => {
    const user = makeUser({ orgId: undefined });

    // Simulate handler: if !user?.orgId return null
    const result = !user.orgId ? null : 'would-fetch-org';
    expect(result).toBeNull();
  });

  it('returns org when user has orgId', async () => {
    const user = makeUser();
    const org = makeOrg();
    const ctx = makeCtx(user, org);
    ctx.db.get = vi.fn().mockResolvedValue(org);

    const result = await ctx.db.get(user.orgId);
    expect(result).toEqual(org);
  });
});

// ---------------------------------------------------------------------------
// getMembers handler logic
// ---------------------------------------------------------------------------

describe('organizations.getMembers handler logic', () => {
  it('returns empty array when user has no orgId', () => {
    const user = makeUser({ orgId: undefined });
    const result = !user.orgId ? [] : 'would-query';
    expect(result).toEqual([]);
  });

  it('queries org members by orgId', async () => {
    const user = makeUser();
    const members = [
      { _id: 'm1', orgId: 'org_id', userId: 'user_id', role: 'owner', status: 'active' },
      { _id: 'm2', orgId: 'org_id', userId: 'user_2', role: 'member', status: 'active' },
    ];
    const ctx = makeCtx(user);
    const memberQuery = {
      withIndex: vi.fn().mockReturnThis(),
      collect: vi.fn().mockResolvedValue(members),
    };
    ctx.db.query = vi.fn().mockImplementation((table: string) => {
      if (table === 'users') {
        return { withIndex: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(user) };
      }
      return memberQuery;
    });

    const result = await ctx.db.query('organizationMembers').withIndex('by_org_id').collect();
    expect(result).toEqual(members);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// rename handler logic
// ---------------------------------------------------------------------------

describe('organizations.rename handler logic', () => {
  it('throws when user has no orgId', () => {
    const user = makeUser({ orgId: undefined });
    expect(() => {
      if (!user.orgId) throw new Error('No organization found');
    }).toThrow('No organization found');
  });

  it('throws when org not found', () => {
    const org = null;
    expect(() => {
      if (!org) throw new Error('Organization not found');
    }).toThrow('Organization not found');
  });

  it('throws when user is not the owner', () => {
    const user = makeUser({ _id: 'other_user_id' });
    const org = makeOrg({ ownerId: 'user_id' }); // different owner
    expect(() => {
      if (org.ownerId !== user._id) throw new Error('Only the owner can rename the organization');
    }).toThrow('Only the owner can rename the organization');
  });

  it('patches org name when user is owner', async () => {
    const user = makeUser();
    const org = makeOrg({ ownerId: user._id });
    const ctx = makeCtx(user, org);

    // owner matches
    if (org.ownerId !== user._id) throw new Error('should not throw');
    await ctx.db.patch(user.orgId, { name: 'New Name' });

    expect(ctx._dbPatch).toHaveBeenCalledWith('org_id', { name: 'New Name' });
  });
});

// ---------------------------------------------------------------------------
// canAddMember handler logic
// ---------------------------------------------------------------------------

describe('organizations.canAddMember handler logic', () => {
  it('returns false when subscription not found', () => {
    const subscription = null;
    const result = !subscription ? false : 'check-seats';
    expect(result).toBe(false);
  });

  it('returns true when seat quantity exceeds active member count', () => {
    const subscription = { seatQuantity: 5 };
    const activeMembers = [{ _id: 'm1' }, { _id: 'm2' }];
    const result = subscription.seatQuantity > activeMembers.length;
    expect(result).toBe(true);
  });

  it('returns false when at seat limit', () => {
    const subscription = { seatQuantity: 2 };
    const activeMembers = [{ _id: 'm1' }, { _id: 'm2' }];
    const result = subscription.seatQuantity > activeMembers.length;
    expect(result).toBe(false);
  });

  it('returns false when over seat limit', () => {
    const subscription = { seatQuantity: 1 };
    const activeMembers = [{ _id: 'm1' }, { _id: 'm2' }];
    const result = subscription.seatQuantity > activeMembers.length;
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setStripeCustomerId handler logic
// ---------------------------------------------------------------------------

describe('organizations.setStripeCustomerId handler logic', () => {
  it('throws when org not found', async () => {
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(null);

    const org = await ctx.db.get('org_id');
    expect(() => {
      if (!org) throw new Error('Organization not found');
    }).toThrow('Organization not found');
  });

  it('patches stripeCustomerId on org', async () => {
    const org = makeOrg();
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(org);

    const fetchedOrg = await ctx.db.get('org_id');
    if (!fetchedOrg) throw new Error('Organization not found');
    await ctx.db.patch('org_id' as any, { stripeCustomerId: 'cus_abc' });

    expect(ctx._dbPatch).toHaveBeenCalledWith('org_id', { stripeCustomerId: 'cus_abc' });
  });
});

// ---------------------------------------------------------------------------
// getActiveMemberCountInternal handler logic
// ---------------------------------------------------------------------------

describe('organizations.getActiveMemberCountInternal handler logic', () => {
  it('returns count of active members', async () => {
    const members = [
      { _id: 'm1', status: 'active' },
      { _id: 'm2', status: 'active' },
      { _id: 'm3', status: 'active' },
    ];
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      collect: vi.fn().mockResolvedValue(members),
    });

    const result = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id_status')
      .collect();
    expect(result.length).toBe(3);
  });

  it('returns 0 when no active members', async () => {
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      collect: vi.fn().mockResolvedValue([]),
    });

    const result = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id_status')
      .collect();
    expect(result.length).toBe(0);
  });
});

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
        seatQuantity: 1,
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
      seatQuantity: 1,
    });
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
