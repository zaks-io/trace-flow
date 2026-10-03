import { describe, expect, it } from 'vitest';
import {
  accountLabel,
  accountOptionLabel,
  accountRequestsHref,
  identityLabel,
  parseAccountKey,
  requestSourceLabel,
  tryParseAccountKey,
} from '../upstreamAccount';

const REF = 'd'.repeat(64);
const INSTALLATION = 'abcdef01-0000-4000-8000-000000000001';

describe('upstream account', () => {
  it('labels verified, credential, and unavailable identities without conflating them', () => {
    const verified = parseAccountKey(`${INSTALLATION}/openai/provider-account/${REF}`);
    const credential = parseAccountKey(`${INSTALLATION}/openai/credential/${REF}`);
    const unknown = parseAccountKey(`${INSTALLATION}/openai/unknown/`);

    expect(identityLabel(verified.coverage)).toBe('Verified account');
    expect(identityLabel(credential.coverage)).toBe('Credential');
    expect(identityLabel(unknown.coverage)).toBe('Identity unavailable');
    expect(accountLabel(verified)).toBe('Account dddddddd');
    expect(accountLabel(unknown)).toBe('Installation abcdef01');
    expect(accountLabel(credential)).toBe('Credential dddddddd');
    expect(accountOptionLabel(credential)).toBe(
      'Credential dddddddd (openai, credential, installation abcdef01)',
    );
    expect(
      accountOptionLabel(
        parseAccountKey(`22222222-2222-4222-8222-222222222222/openai/credential/${REF}`),
      ),
    ).not.toBe(accountOptionLabel(credential));
    expect(accountOptionLabel(unknown)).toBe(
      'Installation abcdef01 (openai, identity unavailable)',
    );
  });

  it('rejects keys that would present a fabricated or unscoped account', () => {
    expect(() => parseAccountKey('')).toThrow('Malformed');
    expect(() => parseAccountKey(`/openai/provider-account/${REF}`)).toThrow('Malformed');
    expect(() => parseAccountKey(`${INSTALLATION}/openai/email/${REF}`)).toThrow('Malformed');
    expect(() => parseAccountKey(`${INSTALLATION}/openai/unknown/${REF}`)).toThrow('inconsistent');
    expect(() => parseAccountKey(`${INSTALLATION}/openai/credential/`)).toThrow('inconsistent');
    expect(tryParseAccountKey(`${INSTALLATION}/openai/email/${REF}`)).toBeNull();
  });

  it('builds a Requests drilldown that carries the account and active Usage filters', () => {
    const key = `${INSTALLATION}/openai/provider-account/${REF}`;
    const href = accountRequestsHref(key, { provider: 'openai', apiKey: 'sha256:abc', model: '' });
    const params = new URL(href, 'https://example.test').searchParams;

    expect(href.startsWith('/app/requests?')).toBe(true);
    expect(params.get('account')).toBe(key);
    expect(params.get('provider')).toBe('openai');
    expect(params.get('apiKey')).toBe('sha256:abc');
    expect(params.has('model')).toBe(false);
  });

  it('names request sources so imported executions are distinguishable', () => {
    expect(requestSourceLabel('imported_execution')).toBe('Local proxy');
    expect(requestSourceLabel('proxy')).toBe('Trace Flow proxy');
    expect(requestSourceLabel('other')).toBe('other');
    expect(requestSourceLabel(undefined)).toBeNull();
  });
});
