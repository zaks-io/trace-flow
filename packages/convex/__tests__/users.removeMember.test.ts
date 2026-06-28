import { describe, expect, it, vi } from 'vitest';
import { removeMember } from '../auth/users';

function queryResult(firstValue: unknown = null, collectValue: unknown[] = []) {
  return {
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstValue),
    collect: vi.fn().mockResolvedValue(collectValue),
  };
}

function makeRemoveMemberCtx() {
  const caller = {
    _id: 'user_owner',
    tokenIdentifier: 'https://auth.example/|auth0|owner',
    email: 'owner@example.com',
    enabled: true,
    orgId: 'org_1',
  };
  const callerMembership = {
    _id: 'member_owner',
    orgId: 'org_1',
    userId: 'user_owner',
    role: 'owner',
    status: 'active',
  };
  const removedMembership = {
    _id: 'member_removed',
    orgId: 'org_1',
    userId: 'user_removed',
    role: 'member',
    status: 'active',
  };
  const removedUser = {
    _id: 'user_removed',
    tokenIdentifier: 'https://auth.example/|auth0|removed',
    email: 'removed@example.com',
    enabled: true,
    orgId: 'org_1',
  };
  const apiKeys = [
    {
      _id: 'api_key_1',
      key: '11111111-1111-1111-1111-111111111111',
      orgId: 'org_1',
      userId: 'user_removed',
      expiresAt: Date.now() + 60_000,
    },
  ];
  const collectorCredentials = [
    {
      _id: 'collector_cred_1',
      hashedSecret: 'hashed-secret-1',
      orgId: 'org_1',
      userId: 'user_removed',
      collectorId: 'collector-1',
      status: 'active',
      expiresAt: Date.now() + 60_000,
    },
  ];

  const usersQuery = queryResult(caller);
  const membersQuery = queryResult(callerMembership);
  const apiKeysQuery = queryResult(null, apiKeys);
  const collectorCredentialsQuery = queryResult(null, collectorCredentials);

  const dbGet = vi.fn(async (id: string) => {
    if (id === removedMembership._id) return removedMembership;
    if (id === removedUser._id) return removedUser;
    return null;
  });
  const dbPatch = vi.fn().mockResolvedValue(undefined);
  const dbDelete = vi.fn().mockResolvedValue(undefined);
  const schedulerRunAfter = vi.fn().mockResolvedValue('scheduled');

  const ctx = {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue({ tokenIdentifier: caller.tokenIdentifier }),
    },
    db: {
      get: dbGet,
      patch: dbPatch,
      delete: dbDelete,
      query: vi.fn((table: string) => {
        if (table === 'users') return usersQuery;
        if (table === 'organizationMembers') return membersQuery;
        if (table === 'apiKeys') return apiKeysQuery;
        if (table === 'collectorCredentials') return collectorCredentialsQuery;
        throw new Error(`Unexpected table: ${table}`);
      }),
    },
    scheduler: {
      runAfter: schedulerRunAfter,
    },
  };

  return {
    ctx,
    removedMembership,
    removedUser,
    apiKeys,
    collectorCredentials,
    dbPatch,
    dbDelete,
    schedulerRunAfter,
  };
}

describe('auth.users.removeMember', () => {
  it('revokes removed member API keys and collector credentials', async () => {
    const {
      ctx,
      removedMembership,
      removedUser,
      apiKeys,
      collectorCredentials,
      dbPatch,
      dbDelete,
      schedulerRunAfter,
    } = makeRemoveMemberCtx();

    await (
      removeMember as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<void> }
    )._handler(ctx, {
      memberId: removedMembership._id,
    });

    expect(dbPatch).toHaveBeenCalledWith(removedMembership._id, {
      status: 'removed',
      removedAt: expect.any(Number),
    });
    expect(dbPatch).toHaveBeenCalledWith(removedUser._id, { orgId: undefined });
    expect(dbDelete).toHaveBeenCalledWith(apiKeys[0]._id);
    expect(dbPatch).toHaveBeenCalledWith(collectorCredentials[0]._id, {
      status: 'revoked',
      revokedAt: expect.any(Number),
    });

    const scheduledArgs = schedulerRunAfter.mock.calls.map((call) => call[2]);
    expect(scheduledArgs).toEqual(
      expect.arrayContaining([
        { key: apiKeys[0].key },
        { hashedSecret: collectorCredentials[0].hashedSecret },
        { sub: 'auth0|removed' },
      ]),
    );
  });
});
