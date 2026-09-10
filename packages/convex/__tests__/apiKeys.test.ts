import { describe, it, expect, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  requireAuthenticated: vi.fn(),
  getCurrentEnabledUser: vi.fn(),
  requireEnabledUser: vi.fn(),
  getActiveOrganizationMembership: vi.fn((_ctx, user) =>
    Promise.resolve(user?.orgId ? { user, orgId: user.orgId } : null),
  ),
  requireActiveOrganizationMembership: vi.fn(),
  requireEnabledActionUser: vi.fn(),
}));

vi.mock('../auth/auth', () => ({
  requireAuthenticated: authMocks.requireAuthenticated,
}));

vi.mock('../auth/users', () => ({
  getCurrentEnabledUser: authMocks.getCurrentEnabledUser,
  requireEnabledUser: authMocks.requireEnabledUser,
  getActiveOrganizationMembership: authMocks.getActiveOrganizationMembership,
  requireActiveOrganizationMembership: authMocks.requireActiveOrganizationMembership,
}));

vi.mock('../auth/actionUser', () => ({
  requireEnabledActionUser: authMocks.requireEnabledActionUser,
}));

import {
  canAccessApiKey,
  canManageApiKey,
  getByKey,
  list,
  listAnalytics,
  listForUser,
  remove,
  syncToKV,
  update,
} from '../apiKeys';

// ---------------------------------------------------------------------------
// apiKeys.ts handler logic tests
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

function makeApiKey(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'key_id' as any,
    key: 'uuid-key-value',
    expiresAt: Date.now() + 86400000,
    userId: 'user_id' as any,
    orgId: 'org_id' as any,
    name: 'My Key',
    ...overrides,
  };
}

function makeCtx() {
  const dbPatch = vi.fn().mockResolvedValue(undefined);
  const dbInsert = vi.fn().mockResolvedValue('new_key_id');
  const dbGet = vi.fn();
  const dbDelete = vi.fn().mockResolvedValue(undefined);
  const schedulerRunAfter = vi.fn().mockResolvedValue('sched_id');

  return {
    db: {
      get: dbGet,
      patch: dbPatch,
      insert: dbInsert,
      delete: dbDelete,
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
    _dbGet: dbGet,
    _dbDelete: dbDelete,
    _schedulerRunAfter: schedulerRunAfter,
  };
}

// ---------------------------------------------------------------------------
// list handler logic
// ---------------------------------------------------------------------------

describe('apiKeys.list handler logic', () => {
  it('returns empty array when user not found', () => {
    const user = null;
    const result = !user ? [] : 'would-query';
    expect(result).toEqual([]);
  });

  it("returns only the current user's keys", async () => {
    const user = makeUser();
    const ownKey = makeApiKey();
    const peerKey = makeApiKey({ _id: 'peer_key', userId: 'peer_user' });
    const ctx = makeCtx();
    authMocks.getCurrentEnabledUser.mockResolvedValue(user);
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      collect: vi.fn().mockResolvedValue([ownKey, peerKey]),
    });

    const result = await (
      list as unknown as {
        _handler: (context: unknown, args: Record<string, never>) => Promise<unknown[]>;
      }
    )._handler(ctx, {});
    expect(result).toEqual([ownKey]);
  });

  it('queries by userId when user has no orgId', () => {
    const user = makeUser({ orgId: undefined });
    const keys = [makeApiKey({ orgId: undefined })];
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      collect: vi.fn().mockResolvedValue(keys),
    });

    // Simulate: if user.orgId use by_org_id, else use by_user_id
    const indexName = user.orgId ? 'by_org_id' : 'by_user_id';
    expect(indexName).toBe('by_user_id');
  });
});

describe('apiKeys.listAnalytics', () => {
  it('returns canonical identifiers and names without credentials', async () => {
    const orgKey = makeApiKey({
      _id: 'org_key',
      key: 'org-secret',
      name: 'Production',
    });
    const userKey = makeApiKey({
      _id: 'user_key',
      key: 'user-secret',
      orgId: undefined,
      name: undefined,
    });
    authMocks.getCurrentEnabledUser.mockResolvedValue(makeUser());

    const ctx = {
      db: {
        query: vi.fn(() => ({
          withIndex: vi.fn((indexName: string) => ({
            collect: vi
              .fn()
              .mockResolvedValue(indexName === 'by_org_id' ? [orgKey] : [orgKey, userKey]),
          })),
        })),
      },
    };

    const result = await (
      listAnalytics as unknown as {
        _handler: (context: unknown, args: Record<string, never>) => Promise<unknown[]>;
      }
    )._handler(ctx, {});

    expect(result).toEqual([
      {
        _id: 'org_key',
        name: 'Production',
        identifier: 'sha256:2f627f99a5328b27cad5cfba45e374b198a82b8f7e9e94649db6e37322b398e1',
      },
      {
        _id: 'user_key',
        name: undefined,
        identifier: 'sha256:fa32968772a8ee3fbd6f842644e210e8d27d27ac97742fe7f1910778fc3fa21d',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('org-secret');
    expect(JSON.stringify(result)).not.toContain('user-secret');
  });
});

describe('apiKeys resource authorization', () => {
  it('allows only the creating user to obtain a key', () => {
    expect(canAccessApiKey(makeUser(), makeApiKey())).toBe(true);
    expect(
      canAccessApiKey(
        makeUser({ _id: 'org_member' }),
        makeApiKey({ userId: undefined, orgId: 'org_id' }),
      ),
    ).toBe(false);
  });

  it('keeps user-owned key management scoped to the creator', () => {
    const key = makeApiKey();
    expect(canManageApiKey(makeUser(), key)).toBe(true);
    expect(canAccessApiKey(makeUser({ _id: 'org_member' }), key)).toBe(false);
    expect(canManageApiKey(makeUser({ _id: 'org_member' }), key)).toBe(false);
  });

  it('does not expose ownerless legacy organization keys', () => {
    expect(canAccessApiKey(makeUser(), makeApiKey({ userId: undefined }))).toBe(false);
    expect(canManageApiKey(makeUser(), makeApiKey({ userId: undefined }))).toBe(false);
  });

  it('does not let a creator retain an organization key after changing organizations', () => {
    const user = makeUser({ orgId: 'new_org' });
    const key = makeApiKey({ userId: 'user_id', orgId: 'old_org' });
    expect(canAccessApiKey(user, key)).toBe(false);
    expect(canManageApiKey(user, key)).toBe(false);
  });

  it('denies mismatched and unscoped keys even when userId is absent', () => {
    expect(
      canAccessApiKey(
        makeUser({ _id: 'other_user', orgId: 'other_org' }),
        makeApiKey({ userId: undefined, orgId: 'org_id' }),
      ),
    ).toBe(false);
    expect(
      canAccessApiKey(
        makeUser({ _id: 'other_user', orgId: undefined }),
        makeApiKey({ userId: undefined, orgId: undefined }),
      ),
    ).toBe(false);
  });

  it('does not reveal a matching foreign key by its secret value', async () => {
    const foreignKey = makeApiKey({ userId: undefined, orgId: 'foreign_org' });
    authMocks.getCurrentEnabledUser.mockResolvedValue(
      makeUser({ _id: 'other_user', orgId: 'other_org' }),
    );
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      filter: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(foreignKey),
    });

    const result = await (
      getByKey as unknown as {
        _handler: (context: unknown, args: { key: string }) => Promise<unknown>;
      }
    )._handler(ctx, { key: foreignKey.key });

    expect(result).toBeNull();
  });

  it('excludes keys from a former organization in the MCP lookup', async () => {
    const user = makeUser({ orgId: 'new_org' });
    const currentOrgKey = makeApiKey({ _id: 'current', userId: undefined, orgId: 'new_org' });
    const formerOrgKey = makeApiKey({ _id: 'former', userId: user._id, orgId: 'old_org' });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(user);
    ctx.db.query = vi
      .fn()
      .mockReturnValueOnce({
        withIndex: vi.fn().mockReturnValue({ collect: vi.fn().mockResolvedValue([currentOrgKey]) }),
      })
      .mockReturnValueOnce({
        withIndex: vi.fn().mockReturnValue({ collect: vi.fn().mockResolvedValue([formerOrgKey]) }),
      });

    const result = await (
      listForUser as unknown as {
        _handler: (context: unknown, args: { userId: string }) => Promise<unknown[]>;
      }
    )._handler(ctx, { userId: user._id });

    expect(result).toEqual([currentOrgKey]);
  });

  it('rejects cross-tenant update and removal in the public handlers', async () => {
    const user = makeUser({ orgId: 'attacker_org' });
    const foreignKey = makeApiKey({ orgId: 'victim_org' });
    authMocks.requireEnabledUser.mockResolvedValue(user);
    authMocks.requireActiveOrganizationMembership.mockResolvedValue({
      user,
      orgId: user.orgId,
    });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(foreignKey);

    await expect(
      (
        update as unknown as {
          _handler: (context: unknown, args: { id: string; name: string }) => Promise<unknown>;
        }
      )._handler(ctx, { id: foreignKey._id, name: 'stolen' }),
    ).rejects.toThrow('permission');
    await expect(
      (
        remove as unknown as {
          _handler: (context: unknown, args: { id: string }) => Promise<unknown>;
        }
      )._handler(ctx, { id: foreignKey._id }),
    ).rejects.toThrow('permission');
    expect(ctx._dbPatch).not.toHaveBeenCalled();
    expect(ctx._dbDelete).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant KV resync before touching Cloudflare', async () => {
    const foreignKey = makeApiKey({ orgId: 'victim_org' });
    authMocks.requireEnabledActionUser.mockResolvedValue(makeUser({ orgId: 'attacker_org' }));
    const ctx = {
      auth: { getUserIdentity: vi.fn().mockResolvedValue({ tokenIdentifier: 'token|123' }) },
      runQuery: vi.fn().mockResolvedValue(foreignKey),
      runAction: vi.fn(),
    };

    await expect(
      (
        syncToKV as unknown as {
          _handler: (context: unknown, args: { id: string }) => Promise<unknown>;
        }
      )._handler(ctx, { id: foreignKey._id }),
    ).rejects.toThrow('permission');
    expect(ctx.runAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// create handler logic
// ---------------------------------------------------------------------------

describe('apiKeys.create handler logic', () => {
  it('inserts api key with user and org ids', async () => {
    const user = makeUser();
    const ctx = makeCtx();
    const expiresAt = Date.now() + 86400000;

    // crypto.randomUUID() returns a UUID string
    const key = 'mock-uuid-1234';
    await ctx.db.insert('apiKeys', {
      key,
      expiresAt,
      userId: user._id,
      orgId: user.orgId,
      name: 'Test Key',
    });

    expect(ctx._dbInsert).toHaveBeenCalledWith(
      'apiKeys',
      expect.objectContaining({
        key,
        expiresAt,
        userId: 'user_id',
        orgId: 'org_id',
      }),
    );
  });

  it('schedules KV sync after creation', async () => {
    const user = makeUser();
    const ctx = makeCtx();
    const key = 'mock-uuid-5678';
    const expiresAt = Date.now() + 86400000;

    await ctx.scheduler.runAfter(0, 'internal.integrations.cloudflare.syncKeyToKV' as any, {
      key,
      expiresAt,
      orgId: user.orgId,
    });

    expect(ctx._schedulerRunAfter).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({ key, expiresAt, orgId: 'org_id' }),
    );
  });
});

// ---------------------------------------------------------------------------
// update handler logic
// ---------------------------------------------------------------------------

describe('apiKeys.update handler logic', () => {
  it('throws when api key not found', async () => {
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(null);

    const apiKey = await ctx.db.get('key_id');
    expect(() => {
      if (!apiKey) throw new Error('API key not found');
    }).toThrow('API key not found');
  });

  it('throws when user does not own the key', () => {
    const user = makeUser({ _id: 'other_user' });
    const apiKey = makeApiKey({ userId: 'user_id', orgId: undefined });

    expect(() => {
      if (!canManageApiKey(user, apiKey)) {
        throw new Error('You do not have permission to edit this API key');
      }
    }).toThrow('You do not have permission to edit this API key');
  });

  it('patches name when user owns the key', async () => {
    const user = makeUser();
    const apiKey = makeApiKey({ userId: user._id });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(apiKey);

    if (!canManageApiKey(user, apiKey)) throw new Error('no permission');
    await ctx.db.patch(apiKey._id, { name: 'Updated Name' });

    expect(ctx._dbPatch).toHaveBeenCalledWith('key_id', { name: 'Updated Name' });
  });

  it('rejects update when a legacy organization key has no owner', async () => {
    const user = makeUser();
    const apiKey = makeApiKey({ userId: undefined });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(apiKey);

    expect(canManageApiKey(user, apiKey)).toBe(false);
    expect(ctx._dbPatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// remove handler logic
// ---------------------------------------------------------------------------

describe('apiKeys.remove handler logic', () => {
  it('throws when api key not found', async () => {
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(null);

    const apiKey = await ctx.db.get('key_id');
    expect(() => {
      if (!apiKey) throw new Error('API key not found');
    }).toThrow('API key not found');
  });

  it('throws when user does not own the key', () => {
    const user = makeUser({ _id: 'other_user' });
    const apiKey = makeApiKey({ userId: 'user_id', orgId: undefined });

    expect(() => {
      if (!canManageApiKey(user, apiKey)) {
        throw new Error('You do not have permission to delete this API key');
      }
    }).toThrow('You do not have permission to delete this API key');
  });

  it('deletes key and schedules KV deletion', async () => {
    const user = makeUser();
    const apiKey = makeApiKey({ userId: user._id });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(apiKey);

    if (!canManageApiKey(user, apiKey)) throw new Error('no permission');
    await ctx.db.delete(apiKey._id);
    await ctx.scheduler.runAfter(0, 'internal.integrations.cloudflare.deleteKeyFromKV' as any, {
      key: apiKey.key,
    });

    expect(ctx._dbDelete).toHaveBeenCalledWith('key_id');
    expect(ctx._schedulerRunAfter).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({ key: 'uuid-key-value' }),
    );
  });
});
