import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { MCP_ACCESS_TOKEN_ALG, MCP_ACCESS_TOKEN_KID } from '@trace-flow/mcp-core';
import { verifyAccessToken } from '../auth';

// Unique connect URL per test so jose's per-URL JWKS cache never bleeds across
// cases (the worker module-level cache is keyed by connectBaseUrl).
let counter = 0;
function freshConnectUrl(): string {
  counter += 1;
  return `https://connect-${counter}.test`;
}

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair(MCP_ACCESS_TOKEN_ALG, {
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: MCP_ACCESS_TOKEN_KID,
    alg: MCP_ACCESS_TOKEN_ALG,
    use: 'sig',
  };
  const sign = (claims: Record<string, unknown>, opts?: { expSeconds?: number }) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: MCP_ACCESS_TOKEN_ALG, kid: MCP_ACCESS_TOKEN_KID })
      .setIssuedAt()
      .setExpirationTime(`${opts?.expSeconds ?? 3600}s`)
      .sign(privateKey);
  return { jwk, sign };
}

describe('verifyAccessToken (JWKS)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies a token signed by the published key', async () => {
    const { jwk, sign } = await setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const token = await sign({ userId: 'u-1', tokenId: 't-1' });
    const payload = await verifyAccessToken(token, freshConnectUrl());
    expect(payload).toEqual({ userId: 'u-1', tokenId: 't-1' });
  });

  it('rejects a token signed by a foreign key', async () => {
    const { jwk } = await setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // Token signed by a DIFFERENT key than the JWKS publishes.
    const { sign: foreignSign } = await setup();
    const token = await foreignSign({ userId: 'u-1', tokenId: 't-1' });
    expect(await verifyAccessToken(token, freshConnectUrl())).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { jwk, sign } = await setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const token = await sign({ userId: 'u-1', tokenId: 't-1' }, { expSeconds: -10 });
    expect(await verifyAccessToken(token, freshConnectUrl())).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifyAccessToken('garbage', freshConnectUrl())).toBeNull();
  });
});
