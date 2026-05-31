import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { MCP_ACCESS_TOKEN_ALG, MCP_ACCESS_TOKEN_KID } from '@trace-flow/mcp-core';
import { TokenVerificationUnavailableError, verifyAccessToken } from '../auth';

// Unique connect URL per test so jose's per-URL JWKS cache never bleeds across
// cases (the worker module-level cache is keyed by connectBaseUrl).
let counter = 0;
const RESOURCE_URL = 'https://mcp.test/mcp';
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
  const sign = (
    claims: Record<string, unknown>,
    opts: { expSeconds?: number; issuer: string; audience?: string },
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: MCP_ACCESS_TOKEN_ALG, kid: MCP_ACCESS_TOKEN_KID })
      .setIssuer(opts.issuer)
      .setAudience(opts.audience ?? RESOURCE_URL)
      .setIssuedAt()
      .setExpirationTime(`${opts.expSeconds ?? 3600}s`)
      .sign(privateKey);
  return { jwk, sign };
}

function stubJwks(jwk: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('verifyAccessToken (JWKS)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies a token signed by the published key', async () => {
    const { jwk, sign } = await setup();
    stubJwks(jwk);

    const connectUrl = freshConnectUrl();
    const token = await sign({ userId: 'u-1', tokenId: 't-1' }, { issuer: connectUrl });
    const payload = await verifyAccessToken(token, connectUrl, RESOURCE_URL);
    expect(payload).toEqual({ userId: 'u-1', tokenId: 't-1' });
  });

  it('rejects a token signed by a foreign key', async () => {
    const { jwk } = await setup();
    stubJwks(jwk);

    // Token signed by a DIFFERENT key than the JWKS publishes.
    const { sign: foreignSign } = await setup();
    const connectUrl = freshConnectUrl();
    const token = await foreignSign({ userId: 'u-1', tokenId: 't-1' }, { issuer: connectUrl });
    expect(await verifyAccessToken(token, connectUrl, RESOURCE_URL)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { jwk, sign } = await setup();
    stubJwks(jwk);
    const connectUrl = freshConnectUrl();
    const token = await sign(
      { userId: 'u-1', tokenId: 't-1' },
      { issuer: connectUrl, expSeconds: -10 },
    );
    expect(await verifyAccessToken(token, connectUrl, RESOURCE_URL)).toBeNull();
  });

  it('rejects a token from the wrong issuer', async () => {
    const { jwk, sign } = await setup();
    stubJwks(jwk);
    const connectUrl = freshConnectUrl();
    const token = await sign({ userId: 'u-1', tokenId: 't-1' }, { issuer: 'https://other.test' });

    expect(await verifyAccessToken(token, connectUrl, RESOURCE_URL)).toBeNull();
  });

  it('rejects a token for the wrong audience', async () => {
    const { jwk, sign } = await setup();
    stubJwks(jwk);
    const connectUrl = freshConnectUrl();
    const token = await sign(
      { userId: 'u-1', tokenId: 't-1' },
      { issuer: connectUrl, audience: 'https://other-mcp.test/mcp' },
    );

    expect(await verifyAccessToken(token, connectUrl, RESOURCE_URL)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifyAccessToken('garbage', freshConnectUrl(), RESOURCE_URL)).toBeNull();
  });

  it('surfaces JWKS fetch failures as service-unavailable errors', async () => {
    const { sign } = await setup();
    const connectUrl = freshConnectUrl();
    const token = await sign({ userId: 'u-1', tokenId: 't-1' }, { issuer: connectUrl });
    const fetchError = new TypeError('fetch failed');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(fetchError);
    const logger = { error: vi.fn() };

    await expect(verifyAccessToken(token, connectUrl, RESOURCE_URL, logger)).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'mcp.auth_jwks_unavailable',
      fetchError,
      expect.objectContaining({
        connectBaseUrl: connectUrl,
        phase: 'jwtVerify/getJwks',
      }),
    );
  });

  it('surfaces JWKS HTTP failures as service-unavailable errors', async () => {
    const { sign } = await setup();
    const connectUrl = freshConnectUrl();
    const token = await sign({ userId: 'u-1', tokenId: 't-1' }, { issuer: connectUrl });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream down', { status: 500 }));
    const logger = { error: vi.fn() };

    await expect(verifyAccessToken(token, connectUrl, RESOURCE_URL, logger)).rejects.toBeInstanceOf(
      TokenVerificationUnavailableError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'mcp.auth_jwks_unavailable',
      expect.any(Error),
      expect.objectContaining({
        connectBaseUrl: connectUrl,
        phase: 'jwtVerify/getJwks',
      }),
    );
  });
});
