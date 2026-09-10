import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findOrCreateUser, initializeUser } from '../auth/users';
import { rateLimiter } from '../rateLimits';

function queryResult(firstValue: unknown) {
  return {
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstValue),
  };
}

function makeCtx(
  existingUser: Record<string, unknown> | null,
  options: {
    emailVerified?: boolean;
    acceptedInvite?: Record<string, unknown> | null;
  } = {},
) {
  const subscription = { _id: 'subscription_1', orgId: 'org_1', tier: 'hobby' };
  const dbInsert = vi.fn(async (table: string) => {
    if (table === 'users') return 'user_new';
    if (table === 'organizations') return 'org_personal';
    return `${table}_new`;
  });

  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue({
        tokenIdentifier: 'https://auth.example/|auth0|user',
        email: 'user@example.com',
        emailVerified: options.emailVerified ?? true,
        name: 'User',
        pictureUrl: 'https://example.com/user.png',
      }),
    },
    db: {
      query: vi.fn((table: string) => {
        if (table === 'users') return queryResult(existingUser);
        if (table === 'invites') return queryResult(options.acceptedInvite ?? null);
        if (table === 'subscriptions') return queryResult(subscription);
        if (table === 'organizationMembers') {
          return queryResult(
            existingUser
              ? { userId: existingUser._id, orgId: existingUser.orgId, status: 'active' }
              : null,
          );
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
      get: vi.fn(async (id: string) =>
        id === 'org_1' || id === 'org_personal'
          ? { _id: id, name: 'Organization', ownerId: existingUser?._id ?? 'user_new' }
          : existingUser,
      ),
      patch: vi.fn().mockResolvedValue(undefined),
      insert: dbInsert,
    },
    scheduler: {
      runAfter: vi.fn().mockResolvedValue('scheduled'),
    },
    dbInsert,
  };
}

const handler = (
  initializeUser as unknown as {
    _handler: (ctx: unknown, args: Record<string, never>) => Promise<{ userId: string }>;
  }
)._handler;

describe('auth.users.initializeUser', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not consume creation quota for an existing user', async () => {
    const existingUser = {
      _id: 'user_existing',
      tokenIdentifier: 'https://auth.example/|auth0|user',
      email: 'user@example.com',
      name: 'User',
      picture: 'https://example.com/user.png',
      enabled: true,
      orgId: 'org_1',
    };
    const ctx = makeCtx(existingUser);
    const limit = vi.spyOn(rateLimiter, 'limit');

    await expect(handler(ctx, {})).resolves.toEqual({ userId: existingUser._id });
    expect(limit).not.toHaveBeenCalled();
    expect(ctx.dbInsert).not.toHaveBeenCalled();
  });

  it('updates changed profile fields without consuming creation quota', async () => {
    const existingUser = {
      _id: 'user_existing',
      tokenIdentifier: 'https://auth.example/|auth0|user',
      email: 'user@example.com',
      name: 'Old Name',
      picture: 'https://example.com/old.png',
      enabled: true,
      orgId: 'org_1',
    };
    const ctx = makeCtx(existingUser);
    const limit = vi.spyOn(rateLimiter, 'limit');

    await expect(handler(ctx, {})).resolves.toEqual({ userId: existingUser._id });
    expect(ctx.db.patch).toHaveBeenCalledWith(existingUser._id, {
      tokenIdentifier: existingUser.tokenIdentifier,
      email: existingUser.email,
      name: 'User',
      picture: 'https://example.com/user.png',
    });
    expect(limit).not.toHaveBeenCalled();
  });

  it('preserves a disabled account and skips login reconciliation', async () => {
    const existingUser = {
      _id: 'user_existing',
      tokenIdentifier: 'https://auth.example/|auth0|user',
      email: 'user@example.com',
      name: 'User',
      picture: 'https://example.com/user.png',
      enabled: false,
      orgId: 'org_1',
    };
    const ctx = makeCtx(existingUser);

    await expect(handler(ctx, {})).resolves.toEqual({ userId: existingUser._id });
    expect(ctx.db.patch).not.toHaveBeenCalled();
    expect(ctx.db.get).not.toHaveBeenCalled();
  });

  it('does not reconcile an accepted invite for an existing unverified identity', async () => {
    const existingUser = {
      _id: 'user_existing',
      tokenIdentifier: 'https://auth.example/|auth0|user',
      email: 'user@example.com',
      name: 'User',
      picture: 'https://example.com/user.png',
      enabled: true,
      orgId: 'org_personal',
    };
    const ctx = makeCtx(existingUser, {
      emailVerified: false,
      acceptedInvite: {
        _id: 'invite_accepted',
        email: existingUser.email,
        orgId: 'org_victim',
        status: 'accepted',
      },
    });

    await expect(handler(ctx, {})).resolves.toEqual({ userId: existingUser._id });
    expect(ctx.db.query).not.toHaveBeenCalledWith('invites');
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });

  it('creates a personal organization instead of consuming an invite for a new unverified identity', async () => {
    const ctx = makeCtx(null, {
      emailVerified: false,
      acceptedInvite: {
        _id: 'invite_accepted',
        email: 'user@example.com',
        orgId: 'org_victim',
        status: 'accepted',
      },
    });
    vi.spyOn(rateLimiter, 'limit').mockResolvedValue({ ok: true, retryAfter: undefined });

    await expect(handler(ctx, {})).resolves.toEqual({ userId: 'user_new' });
    expect(ctx.db.query).not.toHaveBeenCalledWith('invites');
    expect(ctx.dbInsert).toHaveBeenCalledWith(
      'users',
      expect.not.objectContaining({ inviteId: expect.anything() }),
    );
    expect(ctx.db.patch).toHaveBeenCalledWith('user_new', { orgId: 'org_personal' });
    expect(ctx.db.patch).not.toHaveBeenCalledWith('user_new', { orgId: 'org_victim' });
  });

  it('rejects a disabled account in the MCP user reconciliation path', async () => {
    const existingUser = {
      _id: 'user_existing',
      tokenIdentifier: 'https://auth.example/|auth0|user',
      email: 'user@example.com',
      name: 'User',
      picture: 'https://example.com/user.png',
      enabled: false,
      orgId: 'org_1',
    };
    const ctx = makeCtx(existingUser);
    const findHandler = (
      findOrCreateUser as unknown as {
        _handler: (
          context: unknown,
          args: { tokenIdentifier: string; email: string; name?: string; picture?: string },
        ) => Promise<string>;
      }
    )._handler;

    await expect(
      findHandler(ctx, {
        tokenIdentifier: existingUser.tokenIdentifier,
        email: existingUser.email,
        name: existingUser.name,
        picture: existingUser.picture,
      }),
    ).rejects.toThrow('User account is not enabled');
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });

  it('applies creation quota before inserting a new user', async () => {
    const ctx = makeCtx(null);
    vi.spyOn(rateLimiter, 'limit').mockRejectedValue(new Error('rate limited'));

    await expect(handler(ctx, {})).rejects.toThrow('rate limited');
    expect(ctx.dbInsert).not.toHaveBeenCalled();
  });
});
