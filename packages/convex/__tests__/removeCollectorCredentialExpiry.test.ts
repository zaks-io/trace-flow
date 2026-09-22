import { describe, expect, it, vi } from 'vitest';
import { removeCollectorCredentialExpiry } from '../migrations/removeCollectorCredentialExpiry';

type MigrationHandler = (
  ctx: unknown,
  args: Record<string, never>,
) => Promise<{ scanned: number; migrated: number }>;

const handler = (removeCollectorCredentialExpiry as unknown as { _handler: MigrationHandler })
  ._handler;

describe('removeCollectorCredentialExpiry', () => {
  it('clears expiry and re-syncs only active legacy credentials', async () => {
    const activeLegacy = {
      _id: 'active-legacy',
      _creationTime: 100,
      hashedSecret: 'hash-1',
      orgId: 'org-1',
      userId: 'user-1',
      collectorId: 'collector-1',
      status: 'active',
      expiresAt: 200,
    };
    const credentials = [
      activeLegacy,
      { ...activeLegacy, _id: 'active-current', expiresAt: undefined },
      { ...activeLegacy, _id: 'revoked-legacy', status: 'revoked' },
    ];
    const patch = vi.fn();
    const runAfter = vi.fn();

    const result = await handler(
      {
        db: {
          query: vi.fn().mockReturnValue({ collect: vi.fn().mockResolvedValue(credentials) }),
          patch,
        },
        scheduler: { runAfter },
      },
      {},
    );

    expect(result).toEqual({ scanned: 3, migrated: 1 });
    expect(patch).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith('active-legacy', { expiresAt: undefined });
    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({
        hashedSecret: 'hash-1',
        orgId: 'org-1',
        collectorId: 'collector-1',
      }),
    );
    expect(runAfter.mock.calls[0]?.[2]).not.toHaveProperty('expiresAt');
  });
});
