import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@trace-flow/utils';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { s256Challenge } from '../httpRoutes/mcpPkce';
import { initConvexTest } from './convexTest.setup';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const OTHER_VERIFIER = 'a'.repeat(43);

beforeEach(() => {
  // Minting schedules a KV sync; fake timers keep it from running against Cloudflare.
  vi.useFakeTimers();
  vi.stubEnv('AXIOM_TOKEN', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seedMember(t: ReturnType<typeof initConvexTest>): Promise<Id<'users'>> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://auth.example/|auth0|collector-login',
      email: 'collector-login@example.com',
      enabled: true,
    });
    const orgId = await ctx.db.insert('organizations', {
      name: 'Collector login',
      ownerId: userId,
    });
    await ctx.db.patch(userId, { orgId });
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId,
      role: 'owner',
      status: 'active',
      joinedAt: 1,
    });
    return userId;
  });
}

async function issueCode(t: ReturnType<typeof initConvexTest>, userId: Id<'users'>) {
  return t.mutation(internal.collectorLogin.createLoginCode, {
    userId,
    codeChallenge: await s256Challenge(VERIFIER),
  });
}

function redeem(t: ReturnType<typeof initConvexTest>, code: string, verifier: string) {
  return t.fetch('/collector/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, code_verifier: verifier }).toString(),
  });
}

describe('Collector sign-in codes', () => {
  it('matches the RFC 7636 S256 example', async () => {
    expect(await s256Challenge(VERIFIER)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('mints a credential only for the verifier, once, and stores only hashes', async () => {
    const t = initConvexTest();
    const userId = await seedMember(t);
    const code = await issueCode(t, userId);

    const stored = await t.run((ctx) => ctx.db.query('collectorLoginCodes').collect());
    expect(stored).toHaveLength(1);
    expect(stored[0].codeHash).toBe(await sha256Hex(code));
    expect(JSON.stringify(stored)).not.toContain(code);

    const wrong = await redeem(t, code, OTHER_VERIFIER);
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe('invalid_grant');
    expect(await t.run((ctx) => ctx.db.query('collectorCredentials').collect())).toHaveLength(0);

    const res = await redeem(t, code, VERIFIER);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.secret).toMatch(/^tfc_/);
    expect(body.collector_id).toMatch(/^cli-/);
    const credentials = await t.run((ctx) => ctx.db.query('collectorCredentials').collect());
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      hashedSecret: await sha256Hex(body.secret),
      orgId: body.org_id,
      userId,
      collectorId: body.collector_id,
      status: 'active',
    });
    expect(await t.run((ctx) => ctx.db.query('collectorLoginCodes').collect())).toHaveLength(0);

    const again = await redeem(t, code, VERIFIER);
    expect(again.status).toBe(400);
    expect(await t.run((ctx) => ctx.db.query('collectorCredentials').collect())).toHaveLength(1);
  });

  it('refuses an expired code', async () => {
    const t = initConvexTest();
    const userId = await seedMember(t);
    const code = await issueCode(t, userId);

    vi.advanceTimersByTime(11 * 60 * 1000);
    const res = await redeem(t, code, VERIFIER);
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toBe('Sign-in code is invalid or expired');
  });

  it('tells a user without an organization to create or join one, and keeps the code', async () => {
    const t = initConvexTest();
    const userId = await t.run((ctx) =>
      ctx.db.insert('users', {
        tokenIdentifier: 'https://auth.example/|auth0|no-org',
        email: 'no-org@example.com',
        enabled: true,
      }),
    );
    const code = await issueCode(t, userId);

    const res = await redeem(t, code, VERIFIER);
    expect(res.status).toBe(403);
    expect((await res.json()).error_description).toBe(
      'Create or join a Trace Flow organization on the web first',
    );
    expect(await t.run((ctx) => ctx.db.query('collectorLoginCodes').collect())).toHaveLength(1);
  });

  it('answers 429 once the hourly mint limit is spent', async () => {
    const t = initConvexTest();
    const userId = await seedMember(t);
    for (let i = 0; i < 10; i++) {
      expect((await redeem(t, await issueCode(t, userId), VERIFIER)).status).toBe(200);
    }

    const res = await redeem(t, await issueCode(t, userId), VERIFIER);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await res.json()).error).toBe('temporarily_unavailable');
  });

  it('rejects malformed token requests before touching codes', async () => {
    const t = initConvexTest();

    const json = await t.fetch('/collector/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'x', code_verifier: VERIFIER }),
    });
    expect(json.status).toBe(415);

    const shortVerifier = await redeem(t, 'some-code', 'too-short');
    expect(shortVerifier.status).toBe(400);
    expect((await shortVerifier.json()).error_description).toBe(
      'code_verifier must be a valid PKCE verifier',
    );
  });
});
