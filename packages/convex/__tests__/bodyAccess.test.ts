import { describe, expect, it } from 'vitest';
import { bodyAccessRateLimitKey } from '../bodyAccess';

describe('body access token helpers', () => {
  it('rate-limits body token minting per user, not per request id', () => {
    const userId = 'user_123';

    expect(bodyAccessRateLimitKey(userId)).toBe(userId);
    expect(bodyAccessRateLimitKey(userId)).not.toContain('req_');
  });
});
