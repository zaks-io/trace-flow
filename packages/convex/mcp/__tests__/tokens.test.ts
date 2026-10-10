import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import { initConvexTest } from '../../__tests__/convexTest.setup';

const CLIENT_ID = 'client-1';
const RESOURCE = 'https://mcp.trace-flow.dev/mcp';

async function setup() {
  const t = initConvexTest();
  const userId = await t.run((ctx) =>
    ctx.db.insert('users', { tokenIdentifier: 'auth0|u1', email: 'u1@example.com', enabled: true }),
  );
  const codeVerifier = 'test-code-verifier';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const code = await t.mutation(internal.mcp.tokens.createAuthCode, {
    userId,
    clientId: CLIENT_ID,
    resource: RESOURCE,
    redirectUri: 'https://client.example/callback',
    codeChallenge: Buffer.from(digest).toString('base64url'),
    codeChallengeMethod: 'S256',
    auth0RefreshToken: 'auth0-refresh',
  });
  const grant = await t.mutation(internal.mcp.tokens.exchangeAuthCode, {
    code,
    clientId: CLIENT_ID,
    resource: RESOURCE,
    redirectUri: 'https://client.example/callback',
    codeVerifier,
  });
  if ('error' in grant) throw new Error(grant.error_description);
  const tokenId = grant.tokenId;
  return { t, tokenId };
}

function rotate(t: Awaited<ReturnType<typeof setup>>['t'], tokenId: string, clientId = CLIENT_ID) {
  return t.mutation(internal.mcp.tokens.rotateRefreshToken, {
    tokenId,
    clientId,
    resource: RESOURCE,
  });
}

describe('rotateRefreshToken', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets a concurrent client reuse a just-rotated token within the grace window', async () => {
    const { t, tokenId } = await setup();

    const first = await rotate(t, tokenId);
    vi.advanceTimersByTime(30_000);
    const second = await rotate(t, tokenId);

    expect(first).toMatchObject({ resource: RESOURCE });
    expect(second).toMatchObject({ resource: RESOURCE });
    if ('error' in first || 'error' in second) throw new Error('rotation rejected');
    expect(second.tokenId).not.toBe(first.tokenId);
    expect(first).not.toHaveProperty('reusedRotatedAt');
    expect(second.reusedRotatedAt).toBe(Date.now() - 30_000);
    await expect(rotate(t, first.tokenId)).resolves.not.toHaveProperty('error');
    await expect(rotate(t, second.tokenId)).resolves.not.toHaveProperty('error');
  });

  it('rejects a rotated token after the grace window while its successor stays valid', async () => {
    const { t, tokenId } = await setup();

    const successor = await rotate(t, tokenId);
    if ('error' in successor) throw new Error('rotation rejected');
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);

    await expect(rotate(t, tokenId)).resolves.toEqual({
      error: 'invalid_grant',
      error_description: 'Invalid or expired refresh token',
    });
    await expect(rotate(t, successor.tokenId)).resolves.not.toHaveProperty('error');
  });

  it('does not extend the grace window when the rotated token is reused', async () => {
    const { t, tokenId } = await setup();

    await rotate(t, tokenId);
    vi.advanceTimersByTime(90_000);
    await rotate(t, tokenId);
    vi.advanceTimersByTime(31_000);

    await expect(rotate(t, tokenId)).resolves.toHaveProperty('error', 'invalid_grant');
  });

  it('deletes the retired token when its grace window ends', async () => {
    const { t, tokenId } = await setup();

    await rotate(t, tokenId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run((ctx) => ctx.db.query('mcpRefreshTokens').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rotatedAt).toBeUndefined();
  });

  it('rejects a grace reuse from a different client', async () => {
    const { t, tokenId } = await setup();

    await rotate(t, tokenId);

    await expect(rotate(t, tokenId, 'other-client')).resolves.toHaveProperty(
      'error',
      'invalid_grant',
    );
  });

  it('caps how many successors one retired token can mint', async () => {
    const { t, tokenId } = await setup();

    for (let i = 0; i < 20; i++) {
      await expect(rotate(t, tokenId)).resolves.not.toHaveProperty('error');
    }

    await expect(rotate(t, tokenId)).resolves.toHaveProperty('error', 'invalid_grant');
  });
});
