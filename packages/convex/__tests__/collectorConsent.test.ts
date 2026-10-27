import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  signCollectorConsent,
  signConsent,
  signState,
  verifyCollectorConsent,
  verifyConsent,
} from '../mcp/oauth';
import { acceptedConsent } from './httpTest.setup';

const approval = {
  consentNonce: 'browser-nonce',
  clientState: 'collector-nonce',
  redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
};

beforeEach(() => {
  vi.stubEnv('MCP_JWT_SECRET', 'collector-consent-test-key');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Collector consent tokens', () => {
  it('round-trip exactly what was approved', async () => {
    expect(await verifyCollectorConsent(await signCollectorConsent(approval))).toEqual({
      tokenUse: 'collector_consent',
      ...approval,
    });
    const { codeChallenge: _, ...legacy } = approval;
    expect(await verifyCollectorConsent(await signCollectorConsent(legacy))).toEqual({
      tokenUse: 'collector_consent',
      ...legacy,
    });
  });

  it('refuse a token that was altered or signed with another key', async () => {
    const token = await signCollectorConsent(approval);
    const [header, payload, signature] = token.split('.');
    const altered = JSON.parse(Buffer.from(payload, 'base64url').toString());
    altered.redirectUri = 'http://127.0.0.1:50000/callback';
    const forged = `${header}.${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${signature}`;
    expect(await verifyCollectorConsent(forged)).toBeNull();

    vi.stubEnv('MCP_JWT_SECRET', 'another-key');
    expect(await verifyCollectorConsent(token)).toBeNull();
  });

  it('are not interchangeable with MCP consent or OAuth state tokens', async () => {
    expect(await verifyCollectorConsent(await signConsent(acceptedConsent))).toBeNull();
    expect(
      await verifyCollectorConsent(
        await signState({
          consentNonce: 'browser-nonce',
          clientState: 'collector:x',
          redirectUri: approval.redirectUri,
        }),
      ),
    ).toBeNull();
    expect(await verifyConsent(await signCollectorConsent(approval))).toBeNull();
  });

  it('expire after five minutes', async () => {
    vi.useFakeTimers();
    const token = await signCollectorConsent(approval);
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(await verifyCollectorConsent(token)).not.toBeNull();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(await verifyCollectorConsent(token)).toBeNull();
  });
});
