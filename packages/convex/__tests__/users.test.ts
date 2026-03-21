import { describe, it, expect, vi } from 'vitest';
import { getCurrentUser, requireEnabledUser, requireAdmin } from '../auth/users';

function makeAuthCtx(identityOverrides: Record<string, unknown> | null = {}) {
  const identity =
    identityOverrides === null
      ? null
      : {
          tokenIdentifier: 'token|123',
          email: 'test@example.com',
          'neuron/roles': ['Trace Flow'],
          ...identityOverrides,
        };

  const makeQuery = (result: unknown) => ({
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(result),
    collect: vi.fn().mockResolvedValue(result ? [result] : []),
  });

  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue(identity),
    },
    db: {
      query: vi.fn().mockReturnValue(makeQuery(null)),
      _makeQuery: makeQuery,
    },
  };
}

// ---------------------------------------------------------------------------
// getCurrentUser
// ---------------------------------------------------------------------------

describe('getCurrentUser', () => {
  it('returns null when no identity', async () => {
    const ctx = makeAuthCtx(null);
    const result = await getCurrentUser(ctx as any);
    expect(result).toBeNull();
  });

  it('returns user from db when identity exists', async () => {
    const user = {
      _id: 'user_id',
      tokenIdentifier: 'token|123',
      email: 'test@example.com',
      enabled: true,
    };
    const ctx = makeAuthCtx();
    const userQuery = {
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(user),
    };
    ctx.db.query = vi.fn().mockReturnValue(userQuery);

    const result = await getCurrentUser(ctx as any);
    expect(result).toEqual(user);
    expect(ctx.db.query).toHaveBeenCalledWith('users');
  });

  it('returns null when user not found in db', async () => {
    const ctx2 = makeAuthCtx();
    ctx2.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
    });

    const result = await getCurrentUser(ctx2 as any);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requireEnabledUser
// ---------------------------------------------------------------------------

describe('requireEnabledUser', () => {
  it('throws when no identity (user not found)', async () => {
    const ctx = makeAuthCtx(null);
    await expect(requireEnabledUser(ctx as any)).rejects.toThrow('User not found');
  });

  it('throws when user is not enabled', async () => {
    const disabledUser = {
      _id: 'user_id',
      tokenIdentifier: 'token|123',
      email: 'test@example.com',
      enabled: false,
    };
    const ctx = makeAuthCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(disabledUser),
    });

    await expect(requireEnabledUser(ctx as any)).rejects.toThrow('User account is not enabled');
  });

  it('returns user when enabled', async () => {
    const enabledUser = {
      _id: 'user_id',
      tokenIdentifier: 'token|123',
      email: 'test@example.com',
      enabled: true,
    };
    const ctx = makeAuthCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(enabledUser),
    });

    const result = await requireEnabledUser(ctx as any);
    expect(result).toEqual(enabledUser);
  });
});

// ---------------------------------------------------------------------------
// requireAdmin
// ---------------------------------------------------------------------------

describe('requireAdmin', () => {
  it('throws when user is not admin', async () => {
    const nonAdminUser = {
      _id: 'user_id',
      tokenIdentifier: 'token|123',
      email: 'test@example.com',
      enabled: true,
      isAdmin: false,
    };
    const ctx = makeAuthCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(nonAdminUser),
    });

    await expect(requireAdmin(ctx as any)).rejects.toThrow('Admin access required');
  });

  it('throws when isAdmin is undefined', async () => {
    const user = {
      _id: 'user_id',
      tokenIdentifier: 'token|123',
      email: 'test@example.com',
      enabled: true,
      // isAdmin not set
    };
    const ctx = makeAuthCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(user),
    });

    await expect(requireAdmin(ctx as any)).rejects.toThrow('Admin access required');
  });

  it('returns user when isAdmin is true', async () => {
    const adminUser = {
      _id: 'user_id',
      tokenIdentifier: 'token|123',
      email: 'test@example.com',
      enabled: true,
      isAdmin: true,
    };
    const ctx = makeAuthCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(adminUser),
    });

    const result = await requireAdmin(ctx as any);
    expect(result).toEqual(adminUser);
  });

  it('throws for disabled admin user', async () => {
    const disabledAdmin = {
      _id: 'user_id',
      tokenIdentifier: 'token|123',
      email: 'test@example.com',
      enabled: false,
      isAdmin: true,
    };
    const ctx = makeAuthCtx();
    ctx.db.query = vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(disabledAdmin),
    });

    await expect(requireAdmin(ctx as any)).rejects.toThrow('User account is not enabled');
  });
});
