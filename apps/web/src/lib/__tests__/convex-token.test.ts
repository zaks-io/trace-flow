import { describe, expect, it } from 'vitest';
import { isConvexTokenUsable } from '../convex-token';

function tokenWithPayload(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${encoded}.signature`;
}

describe('isConvexTokenUsable', () => {
  const now = Date.parse('2026-07-17T00:00:00Z');

  it('accepts an unexpired ID token', () => {
    expect(isConvexTokenUsable(tokenWithPayload({ exp: now / 1000 + 60 }), now)).toBe(true);
  });

  it('rejects an expired ID token', () => {
    expect(isConvexTokenUsable(tokenWithPayload({ exp: now / 1000 }), now)).toBe(false);
  });

  it.each([undefined, 'malformed', 'header.invalid.signature', tokenWithPayload({})])(
    'rejects unusable token %s',
    (token) => {
      expect(isConvexTokenUsable(token, now)).toBe(false);
    },
  );
});
