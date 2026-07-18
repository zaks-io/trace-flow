import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeUser } from '../auth/users';
import { rateLimiter } from '../rateLimits';

function queryResult(firstValue: unknown) {
  return {
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstValue),
  };
}

function makeCtx(existingUser: Record<string, unknown> | null) {
  const subscription = { _id: 'subscription_1', orgId: 'org_1', tier: 'hobby' };
  const dbInsert = vi.fn().mockResolvedValue('user_new');

  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue({
        tokenIdentifier: 'https://auth.example/|auth0|user',
        email: 'user@example.com',
        name: 'User',
        pictureUrl: 'https://example.com/user.png',
      }),
    },
    db: {
      query: vi.fn((table: string) => {
        if (table === 'users') return queryResult(existingUser);
        if (table === 'invites') return queryResult(null);
        if (table === 'subscriptions') return queryResult(subscription);
        throw new Error(`Unexpected table: ${table}`);
      }),
      get: vi.fn().mockResolvedValue(existingUser),
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

  it('applies creation quota before inserting a new user', async () => {
    const ctx = makeCtx(null);
    vi.spyOn(rateLimiter, 'limit').mockRejectedValue(new Error('rate limited'));

    await expect(handler(ctx, {})).rejects.toThrow('rate limited');
    expect(ctx.dbInsert).not.toHaveBeenCalled();
  });
});
