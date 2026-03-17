import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_KEY_NAME,
  getPrimaryApiKey,
  isApiKeyActive,
  sortApiKeys,
} from '../useDefaultApiKey.shared';

function makeApiKey(
  overrides: Partial<{ name?: string; key: string; _creationTime: number; expiresAt: number }> = {},
) {
  return {
    _id: 'key-id',
    key: 'key-default',
    expiresAt: Date.now() + 10_000,
    _creationTime: 1,
    ...overrides,
  };
}

describe('sortApiKeys', () => {
  it('sorts named keys ahead of unnamed keys and then by creation time', () => {
    const sorted = sortApiKeys([
      makeApiKey({ key: 'unnamed-late', _creationTime: 3 }),
      makeApiKey({ key: 'beta', name: 'Beta', _creationTime: 4 }),
      makeApiKey({ key: 'alpha', name: 'Alpha', _creationTime: 2 }),
      makeApiKey({ key: 'unnamed-early', _creationTime: 1 }),
    ]);

    expect(sorted.map((apiKey) => apiKey.key)).toEqual([
      'alpha',
      'beta',
      'unnamed-early',
      'unnamed-late',
    ]);
  });
});

describe('getPrimaryApiKey', () => {
  it('prefers the default key when present', () => {
    const primary = getPrimaryApiKey([
      makeApiKey({ key: 'other', name: 'Production', _creationTime: 1 }),
      makeApiKey({ key: 'default', name: DEFAULT_API_KEY_NAME, _creationTime: 2 }),
    ]);

    expect(primary?.key).toBe('default');
  });

  it('falls back to the first sorted key when no default key exists', () => {
    const primary = getPrimaryApiKey([
      makeApiKey({ key: 'second', name: 'Beta', _creationTime: 2 }),
      makeApiKey({ key: 'first', name: 'Alpha', _creationTime: 1 }),
    ]);

    expect(primary?.key).toBe('first');
  });

  it('returns null when there are no keys', () => {
    expect(getPrimaryApiKey([])).toBeNull();
  });

  it('ignores expired keys when selecting a primary key', () => {
    const primary = getPrimaryApiKey([
      makeApiKey({ key: 'expired-default', name: DEFAULT_API_KEY_NAME, expiresAt: 1 }),
      makeApiKey({ key: 'active-key', name: 'Production', expiresAt: Date.now() + 1_000 }),
    ]);

    expect(primary?.key).toBe('active-key');
  });
});

describe('isApiKeyActive', () => {
  it('returns false for expired keys', () => {
    expect(isApiKeyActive(makeApiKey({ expiresAt: 10 }), 20)).toBe(false);
  });

  it('returns true for unexpired keys', () => {
    expect(isApiKeyActive(makeApiKey({ expiresAt: 20 }), 10)).toBe(true);
  });
});
