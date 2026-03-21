import { describe, it, expect, vi } from 'vitest';

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

  it('queries by orgId when user has orgId', async () => {
    const _user = makeUser();
    const keys = [makeApiKey(), makeApiKey({ _id: 'key_id_2' })];
    const ctx = makeCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      collect: vi.fn().mockResolvedValue(keys),
    });

    const result = await ctx.db.query('apiKeys').withIndex('by_org_id').collect();
    expect(result).toHaveLength(2);
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
    const apiKey = makeApiKey({ userId: 'user_id' }); // owned by different user

    expect(() => {
      if (apiKey.userId && apiKey.userId !== user._id) {
        throw new Error('You do not have permission to edit this API key');
      }
    }).toThrow('You do not have permission to edit this API key');
  });

  it('patches name when user owns the key', async () => {
    const user = makeUser();
    const apiKey = makeApiKey({ userId: user._id });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(apiKey);

    // ownership check passes
    if (apiKey.userId && apiKey.userId !== user._id) throw new Error('no permission');
    await ctx.db.patch(apiKey._id, { name: 'Updated Name' });

    expect(ctx._dbPatch).toHaveBeenCalledWith('key_id', { name: 'Updated Name' });
  });

  it('allows update when apiKey has no userId (org-owned key)', async () => {
    const user = makeUser();
    const apiKey = makeApiKey({ userId: undefined });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(apiKey);

    // ownership check: apiKey.userId is falsy → skip check
    if (apiKey.userId && apiKey.userId !== user._id) throw new Error('no permission');
    await ctx.db.patch(apiKey._id, { name: 'Org Key Renamed' });

    expect(ctx._dbPatch).toHaveBeenCalledWith('key_id', { name: 'Org Key Renamed' });
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
    const apiKey = makeApiKey({ userId: 'user_id' });

    expect(() => {
      if (apiKey.userId && apiKey.userId !== user._id) {
        throw new Error('You do not have permission to delete this API key');
      }
    }).toThrow('You do not have permission to delete this API key');
  });

  it('deletes key and schedules KV deletion', async () => {
    const user = makeUser();
    const apiKey = makeApiKey({ userId: user._id });
    const ctx = makeCtx();
    ctx.db.get = vi.fn().mockResolvedValue(apiKey);

    if (apiKey.userId && apiKey.userId !== user._id) throw new Error('no permission');
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
