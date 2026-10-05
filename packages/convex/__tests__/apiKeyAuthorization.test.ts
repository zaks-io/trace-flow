import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../_generated/server';
import { createMcpBackend } from '../mcp/backend';
import { initConvexTest } from './convexTest.setup';

const USAGE_SECRET = 'test-usage-secret';
const MCP_SECRET = 'test-mcp-backend-secret';

beforeEach(() => {
  vi.stubEnv('AXIOM_TOKEN', '');
  vi.stubEnv('USAGE_SYNC_SECRET', USAGE_SECRET);
  vi.stubEnv('MCP_BACKEND_SHARED_SECRET', MCP_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedMember(
  t: ReturnType<typeof initConvexTest>,
  keys: {
    key: string;
    expiresAt?: number;
    permissions?: ('ingest' | 'mcp:read')[];
  }[],
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://auth.example/|auth0|api-key-auth',
      email: 'key-auth@example.com',
      enabled: true,
    });
    const orgId = await ctx.db.insert('organizations', { name: 'Key auth', ownerId: userId });
    await ctx.db.patch(userId, { orgId });
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId,
      role: 'owner',
      status: 'active',
      joinedAt: 1,
    });
    const keyIds = await Promise.all(
      keys.map(({ key, expiresAt, permissions }) =>
        ctx.db.insert('apiKeys', {
          key,
          expiresAt: expiresAt ?? Date.now() + 60_000,
          userId,
          orgId,
          ...(permissions === undefined ? {} : { permissions }),
        }),
      ),
    );
    return { userId, orgId, keyIds };
  });
}

function postKey(key: string, secret: string): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  };
}

describe('live API key authorization', () => {
  it('allows legacy ingest keys and denies MCP-only keys at the worker boundary', async () => {
    const t = initConvexTest();
    await seedMember(t, [
      { key: 'legacy-ingest-key' },
      { key: 'mcp-only-key', permissions: ['mcp:read'] },
    ]);

    const ingest = await t.fetch(
      '/worker/authorize-api-key',
      postKey('legacy-ingest-key', USAGE_SECRET),
    );
    await expect(ingest.json()).resolves.toMatchObject({ authorized: true });

    const denied = await t.fetch(
      '/worker/authorize-api-key',
      postKey('mcp-only-key', USAGE_SECRET),
    );
    await expect(denied.json()).resolves.toEqual({ authorized: false, reason: 'forbidden' });
  });

  it('authorizes only live, unexpired MCP-read keys through the shared-secret route', async () => {
    const t = initConvexTest();
    const owner = await seedMember(t, [
      { key: 'read-key', permissions: ['mcp:read'] },
      { key: 'ingest-key', permissions: ['ingest'] },
      { key: 'expired-read-key', permissions: ['mcp:read'], expiresAt: Date.now() - 1 },
    ]);

    const accepted = await t.fetch(
      '/mcp-backend/authorize-api-key',
      postKey('read-key', MCP_SECRET),
    );
    await expect(accepted.json()).resolves.toEqual({ authorized: true, userId: owner.userId });

    const ingestOnly = await t.fetch(
      '/mcp-backend/authorize-api-key',
      postKey('ingest-key', MCP_SECRET),
    );
    await expect(ingestOnly.json()).resolves.toEqual({ authorized: false, reason: 'forbidden' });

    const expired = await t.fetch(
      '/mcp-backend/authorize-api-key',
      postKey('expired-read-key', MCP_SECRET),
    );
    await expect(expired.json()).resolves.toEqual({ authorized: false, reason: 'expired' });

    const missing = await t.fetch(
      '/mcp-backend/authorize-api-key',
      postKey('missing-key', MCP_SECRET),
    );
    await expect(missing.json()).resolves.toEqual({ authorized: false, reason: 'invalid' });

    const wrongSecret = await t.fetch(
      '/mcp-backend/authorize-api-key',
      postKey('read-key', 'wrong'),
    );
    expect(wrongSecret.status).toBe(401);
  });

  it('rechecks active membership and deletion against current Convex state', async () => {
    const t = initConvexTest();
    const { userId } = await seedMember(t, [
      { key: 'current-read-key', permissions: ['mcp:read'] },
    ]);
    const nextOrgId = await t.run(async (ctx) => {
      const nextOrgId = await ctx.db.insert('organizations', {
        name: 'Next org',
        ownerId: userId,
      });
      await ctx.db.insert('organizationMembers', {
        orgId: nextOrgId,
        userId,
        role: 'owner',
        status: 'active',
        joinedAt: 2,
      });
      return nextOrgId;
    });
    const request = () =>
      t.fetch('/mcp-backend/authorize-api-key', postKey('current-read-key', MCP_SECRET));

    await expect((await request()).json()).resolves.toMatchObject({ authorized: true });
    await t.run((ctx) => ctx.db.patch(userId, { enabled: false }));
    await expect((await request()).json()).resolves.toEqual({
      authorized: false,
      reason: 'invalid',
    });

    await t.run((ctx) => ctx.db.patch(userId, { enabled: true, orgId: nextOrgId }));
    await expect((await request()).json()).resolves.toEqual({
      authorized: false,
      reason: 'invalid',
    });

    const replacementKeyId = await t.run((ctx) =>
      ctx.db.insert('apiKeys', {
        key: 'replacement-read-key',
        expiresAt: Date.now() + 60_000,
        userId,
        orgId: nextOrgId,
        permissions: ['mcp:read'],
      }),
    );
    const replacementRequest = () =>
      t.fetch('/mcp-backend/authorize-api-key', postKey('replacement-read-key', MCP_SECRET));
    await expect((await replacementRequest()).json()).resolves.toMatchObject({ authorized: true });
    await t.run((ctx) => ctx.db.delete(replacementKeyId));
    await expect((await replacementRequest()).json()).resolves.toEqual({
      authorized: false,
      reason: 'invalid',
    });
  });

  it('lists only ingest-capable data-source keys to MCP', async () => {
    const t = initConvexTest();
    const { userId, keyIds } = await seedMember(t, [
      { key: 'legacy-data-source' },
      { key: 'ingest-data-source', permissions: ['ingest', 'mcp:read'] },
      { key: 'mcp-only-data-source', permissions: ['mcp:read'] },
      { key: 'expired-data-source', permissions: ['ingest'], expiresAt: Date.now() - 1 },
    ]);
    const backend = createMcpBackend(
      {
        runQuery: (query: unknown, args: unknown) =>
          (t.query as (query: unknown, args: unknown) => Promise<unknown>)(query, args),
        runAction: vi.fn(),
      } as unknown as ActionCtx,
      userId,
    );

    const keys = await backend.listApiKeys();
    expect(keys.map((key) => key.id)).toEqual([keyIds[0], keyIds[1]]);
    expect(JSON.stringify(keys)).not.toContain('legacy-data-source');
    expect(JSON.stringify(keys)).not.toContain('mcp-only-data-source');
  });
});
