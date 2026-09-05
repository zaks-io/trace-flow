import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from 'jose';
import { MCP_ACCESS_TOKEN_ALG, MCP_ACCESS_TOKEN_KID } from '@trace-flow/mcp-core';

// Real RS256 round trip: Convex signs (createAccessToken), publishes the public
// key (getPublicJwk), and a JWKS consumer (the MCP worker) verifies the token
// against that JWK with no shared secret. Modules are imported dynamically after
// the env keys are stubbed so the cached key promises pick them up.

describe('MCP RS256 access tokens + JWKS', () => {
  let privatePem: string;
  let publicPem: string;
  const resource = 'https://mcp.example.com/mcp';

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair(MCP_ACCESS_TOKEN_ALG, {
      extractable: true,
    });
    privatePem = await exportPKCS8(privateKey);
    publicPem = await exportSPKI(publicKey);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('signs a token that verifies against the published JWK', async () => {
    vi.stubEnv('MCP_JWT_PRIVATE_KEY', privatePem);
    vi.stubEnv('MCP_JWT_PUBLIC_KEY', publicPem);

    const { createAccessToken, validateAccessToken } = await import('../tokens');
    const { getPublicJwk } = await import('../keys');

    const issuer = 'https://connect.test';
    const token = await createAccessToken('user-123', 'token-abc', issuer, resource);
    const jwk = await getPublicJwk();

    expect(jwk.kid).toBe(MCP_ACCESS_TOKEN_KID);
    expect(jwk.alg).toBe(MCP_ACCESS_TOKEN_ALG);
    expect(jwk.use).toBe('sig');
    expect(jwk.d).toBeUndefined(); // public only — no private exponent leaks

    const verifyKey = await importJWK(jwk, MCP_ACCESS_TOKEN_ALG);
    const { payload, protectedHeader } = await jwtVerify(token, verifyKey, {
      algorithms: [MCP_ACCESS_TOKEN_ALG],
      issuer,
      audience: resource,
    });

    expect(protectedHeader.alg).toBe(MCP_ACCESS_TOKEN_ALG);
    expect(protectedHeader.kid).toBe(MCP_ACCESS_TOKEN_KID);
    expect(payload.userId).toBe('user-123');
    expect(payload.tokenId).toBe('token-abc');
    await expect(validateAccessToken(token, issuer, resource)).resolves.toEqual({
      userId: 'user-123',
      tokenId: 'token-abc',
    });
  });

  it('rejects a signed token whose identity claims have the wrong types', async () => {
    vi.stubEnv('MCP_JWT_PUBLIC_KEY', publicPem);
    const issuer = 'https://connect.test';
    const signingKey = await importPKCS8(privatePem, MCP_ACCESS_TOKEN_ALG);
    const token = await new SignJWT({ userId: 123, tokenId: 'token-abc' })
      .setProtectedHeader({ alg: MCP_ACCESS_TOKEN_ALG, kid: MCP_ACCESS_TOKEN_KID })
      .setIssuer(issuer)
      .setAudience(resource)
      .setExpirationTime('1h')
      .sign(signingKey);

    const { validateAccessToken } = await import('../tokens');
    await expect(validateAccessToken(token, issuer, resource)).resolves.toBeNull();
  });

  it('rejects a token signed by a different key', async () => {
    vi.stubEnv('MCP_JWT_PRIVATE_KEY', privatePem);
    vi.stubEnv('MCP_JWT_PUBLIC_KEY', publicPem);

    const { createAccessToken } = await import('../tokens');
    const token = await createAccessToken(
      'user-123',
      'token-abc',
      'https://connect.test',
      resource,
    );

    const { publicKey: otherPublic } = await generateKeyPair(MCP_ACCESS_TOKEN_ALG, {
      extractable: true,
    });
    await expect(
      jwtVerify(token, otherPublic, { algorithms: [MCP_ACCESS_TOKEN_ALG] }),
    ).rejects.toThrow(/signature/i);
  });

  it('throws loudly when the signing key is unset', async () => {
    vi.stubEnv('MCP_JWT_PRIVATE_KEY', '');
    const { createAccessToken } = await import('../tokens');
    await expect(createAccessToken('u', 't', 'https://connect.test', resource)).rejects.toThrow(
      'MCP_JWT_PRIVATE_KEY not configured',
    );
  });
});
