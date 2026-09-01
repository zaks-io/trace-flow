import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mint } from '../collectorCredentials';
import { rateLimiter } from '../rateLimits';

const MAX_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 1);

interface MintArgs {
  collectorId: string;
  expiresAt: number;
}

type MintHandler = (ctx: unknown, args: MintArgs) => Promise<{ id: string; secret: string }>;

const mintHandler = (mint as unknown as { _handler: MintHandler })._handler;

function makeCtx() {
  const user = {
    _id: 'user_1',
    tokenIdentifier: 'https://auth.example/|auth0|user',
    email: 'user@example.com',
    enabled: true,
    orgId: 'org_1',
  };
  const usersQuery = {
    withIndex: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(user),
  };
  const insert = vi.fn().mockResolvedValue('collector_credential_1');
  const runAfter = vi.fn().mockResolvedValue('scheduled');

  return {
    ctx: {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          tokenIdentifier: user.tokenIdentifier,
        }),
      },
      db: {
        query: vi.fn().mockReturnValue(usersQuery),
        insert,
      },
      scheduler: { runAfter },
    },
    insert,
    runAfter,
  };
}

describe('collectorCredentials.mint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(rateLimiter, 'limit').mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('accepts a credential lifetime at the 90-day maximum', async () => {
    const { ctx, insert, runAfter } = makeCtx();
    const expiresAt = NOW_MS + MAX_CREDENTIAL_TTL_MS;

    const result = await mintHandler(ctx, {
      collectorId: 'collector_1',
      expiresAt,
    });

    expect(result.id).toBe('collector_credential_1');
    expect(insert).toHaveBeenCalledWith(
      'collectorCredentials',
      expect.objectContaining({ expiresAt }),
    );
    expect(runAfter).toHaveBeenCalledOnce();
  });

  it('rejects a credential lifetime beyond the 90-day maximum', async () => {
    const { ctx, insert, runAfter } = makeCtx();

    await expect(
      mintHandler(ctx, {
        collectorId: 'collector_1',
        expiresAt: NOW_MS + MAX_CREDENTIAL_TTL_MS + 1,
      }),
    ).rejects.toThrow('Collector Credential expiry must be in the future and within 90 days');

    expect(insert).not.toHaveBeenCalled();
    expect(runAfter).not.toHaveBeenCalled();
  });
});
