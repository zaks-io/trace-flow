import { describe, expect, it } from 'vitest';
import { IMPORTED_ACCOUNT_PLANS } from '../importedExecution';
import { ALL_ATTRIBUTE_KEYS, CLI_PROXY } from '../keys';

describe('imported account plan contract', () => {
  it('registers the plan key so Tinybird SQL may extract it', () => {
    expect(CLI_PROXY.ACCOUNT_PLAN).toBe('cliproxyapi.account.plan');
    expect(ALL_ATTRIBUTE_KEYS).toContain(CLI_PROXY.ACCOUNT_PLAN);
  });

  it('keeps plans as unique lowercase tokens with an explicit unknown', () => {
    expect(new Set(IMPORTED_ACCOUNT_PLANS).size).toBe(IMPORTED_ACCOUNT_PLANS.length);
    for (const plan of IMPORTED_ACCOUNT_PLANS) expect(plan).toMatch(/^[a-z0-9_]+$/);
    expect(IMPORTED_ACCOUNT_PLANS).toContain('unknown');
  });
});
