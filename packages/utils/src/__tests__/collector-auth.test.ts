import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../crypto';
import {
  authenticateCollectorCredential,
  collectorCredKvKey,
  isCollectorCredKvValue,
  type CollectorAuthLogger,
  type CollectorCredStore,
} from '../collector-auth';

const SECRET = 'valid-collector-secret';

function logger(): CollectorAuthLogger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function store(entries: Record<string, string>): CollectorCredStore {
  return {
    get: async (key) => entries[key] ?? null,
  };
}

async function validRecord(over: Record<string, unknown> = {}): Promise<Record<string, string>> {
  return {
    [collectorCredKvKey(await sha256Hex(SECRET))]: JSON.stringify({
      orgId: 'org-1',
      userId: 'user-1',
      collectorId: 'collector-1',
      expiresAt: Date.now() + 3_600_000,
      status: 'active',
      createdAt: Date.now(),
      ...over,
    }),
  };
}

describe('isCollectorCredKvValue', () => {
  it('rejects a missing expiresAt so expiration cannot be bypassed', () => {
    expect(
      isCollectorCredKvValue({
        orgId: 'org-1',
        userId: 'user-1',
        collectorId: 'collector-1',
        status: 'active',
      }),
    ).toBe(false);
  });
});

describe('authenticateCollectorCredential', () => {
  it('rejects a missing secret', async () => {
    const result = await authenticateCollectorCredential(store({}), undefined, logger());
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects an unknown secret', async () => {
    const result = await authenticateCollectorCredential(store({}), SECRET, logger());
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a revoked credential', async () => {
    const result = await authenticateCollectorCredential(
      store(await validRecord({ status: 'revoked' })),
      SECRET,
      logger(),
    );
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects an expired credential', async () => {
    const result = await authenticateCollectorCredential(
      store(await validRecord({ expiresAt: Date.now() - 1 })),
      SECRET,
      logger(),
    );
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects malformed KV JSON', async () => {
    const result = await authenticateCollectorCredential(
      store({ [collectorCredKvKey(await sha256Hex(SECRET))]: '{not-json' }),
      SECRET,
      logger(),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('resolves an active credential without trusting caller tenancy', async () => {
    const result = await authenticateCollectorCredential(
      store(await validRecord()),
      SECRET,
      logger(),
    );
    expect(result).toEqual({
      ok: true,
      credential: {
        orgId: 'org-1',
        userId: 'user-1',
        collectorId: 'collector-1',
        collectorCredentialId: await sha256Hex(SECRET),
      },
    });
  });
});
