import { describe, it, expect } from 'vitest';
import { generateCollectorSecret, hashCollectorSecret } from '../collectorCredentials';
import { decideClaim } from '../agentSessionOwners';
import { withRowSecurityParams } from '../integrations/tinybird';

describe('collector credential secret', () => {
  it('mints a tfc_-prefixed, url-safe secret', () => {
    const secret = generateCollectorSecret();
    expect(secret.startsWith('tfc_')).toBe(true);
    // body is base64url: no +, /, or = padding
    expect(secret.slice(4)).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes → at least 40 base64url chars after the prefix
    expect(secret.length).toBeGreaterThan(40);
  });

  it('mints unique secrets', () => {
    const a = generateCollectorSecret();
    const b = generateCollectorSecret();
    expect(a).not.toBe(b);
  });

  it('hashes to 64 hex chars, deterministically', async () => {
    const secret = 'tfc_fixed-value-for-hashing';
    const h1 = await hashCollectorSecret(secret);
    const h2 = await hashCollectorSecret(secret);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different secrets hash differently', async () => {
    const h1 = await hashCollectorSecret('tfc_a');
    const h2 = await hashCollectorSecret('tfc_b');
    expect(h1).not.toBe(h2);
  });

  it('hashes the empty string deterministically to 64 hex chars', async () => {
    const h1 = await hashCollectorSecret('');
    const h2 = await hashCollectorSecret('');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('agentSessionOwners.decideClaim', () => {
  it('claims an unowned session', () => {
    expect(decideClaim(null, 'user_1')).toBe('claimed');
  });

  it('treats same-user re-sync as owned (idempotent)', () => {
    expect(decideClaim('user_1', 'user_1')).toBe('owned');
  });

  it('rejects a different user as conflict', () => {
    expect(decideClaim('user_1', 'user_2')).toBe('conflict');
  });
});

describe('tinybird withRowSecurityParams', () => {
  it('always emits org_id on the agent-pipe scope shape (no fixed_params)', () => {
    const [scope] = withRowSecurityParams([{ type: 'PIPES:READ', resource: 'agent_x' }], {
      apiKeyString: '',
      retentionDays: 7,
      orgId: 'org_123',
    });
    expect(scope.fixed_params?.org_id).toBe('org_123');
    expect(scope.fixed_params?.api_keys).toBe('__NO_KEYS__');
    expect(scope.fixed_params?.retention_days).toBe(7);
  });

  it('falls back to the org sentinel when orgId is empty', () => {
    const [scope] = withRowSecurityParams([{ type: 'PIPES:READ', resource: 'agent_x' }], {
      apiKeyString: 'key',
      retentionDays: 30,
      orgId: '',
    });
    expect(scope.fixed_params?.org_id).toBe('__NO_ORG__');
  });

  it('returns an empty array for empty scopes', () => {
    expect(
      withRowSecurityParams([], { apiKeyString: '', retentionDays: 7, orgId: 'org_1' }),
    ).toEqual([]);
  });

  it('preserves pre-existing fixed_params while adding org_id', () => {
    const [scope] = withRowSecurityParams(
      [{ type: 'PIPES:READ', resource: 'llm', fixed_params: { extra: 'keep' } }],
      { apiKeyString: 'key', retentionDays: 30, orgId: 'org_9' },
    );
    expect(scope.fixed_params?.extra).toBe('keep');
    expect(scope.fixed_params?.org_id).toBe('org_9');
    expect(scope.fixed_params?.api_keys).toBe('key');
  });
});
