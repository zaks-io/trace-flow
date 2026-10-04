import { api, internal } from '../_generated/api';
import { apiKeyPermissions, hasApiKeyPermission } from '../apiKeyPermissions';
import { initConvexTest } from './convexTest.setup';
import { describe, expect, it } from 'vitest';

describe('API key permissions', () => {
  it('treats permissionless legacy keys as ingest-only and empty arrays as no grants', () => {
    expect(apiKeyPermissions({})).toEqual(['ingest']);
    expect(hasApiKeyPermission({}, 'ingest')).toBe(true);
    expect(hasApiKeyPermission({}, 'mcp:read')).toBe(false);
    expect(apiKeyPermissions({ permissions: [] })).toEqual([]);
  });

  it('stores default, explicit, deduplicated, and combined permissions', async () => {
    const t = initConvexTest();
    const tokenIdentifier = 'https://auth.example/|auth0|api-key-permissions';
    const userId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier,
        email: 'permissions@example.com',
        enabled: true,
      });
      const orgId = await ctx.db.insert('organizations', { name: 'Permissions', ownerId: userId });
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
    const asUser = t.withIdentity({ tokenIdentifier });
    const expiresAt = Date.now() + 60_000;

    const defaultId = await asUser.mutation(api.apiKeys.create, { expiresAt });
    const readId = await asUser.mutation(api.apiKeys.create, {
      expiresAt,
      permissions: ['mcp:read'],
    });
    const deduplicatedId = await asUser.mutation(api.apiKeys.create, {
      expiresAt,
      permissions: ['ingest', 'ingest'],
    });
    const combinedId = await asUser.mutation(api.apiKeys.create, {
      expiresAt,
      permissions: ['mcp:read', 'ingest'],
    });

    await expect(t.run((ctx) => ctx.db.get(defaultId))).resolves.toMatchObject({
      permissions: ['ingest'],
    });
    await expect(t.run((ctx) => ctx.db.get(readId))).resolves.toMatchObject({
      permissions: ['mcp:read'],
    });
    await expect(t.run((ctx) => ctx.db.get(deduplicatedId))).resolves.toMatchObject({
      permissions: ['ingest'],
    });
    await expect(t.run((ctx) => ctx.db.get(combinedId))).resolves.toMatchObject({
      permissions: ['mcp:read', 'ingest'],
    });

    await expect(
      asUser.mutation(api.apiKeys.create, { expiresAt, permissions: [] }),
    ).rejects.toThrow('Choose at least one API key permission');
    await expect(
      asUser.mutation(api.apiKeys.create, {
        expiresAt,
        permissions: ['write'],
      } as never),
    ).rejects.toThrow();

    await expect(
      asUser.mutation(api.apiKeys.update, { id: readId, permissions: ['ingest'] } as never),
    ).rejects.toThrow();
    await expect(t.run((ctx) => ctx.db.get(readId))).resolves.toMatchObject({
      permissions: ['mcp:read'],
    });

    await expect(asUser.action(api.apiKeys.syncToKV, { id: readId })).rejects.toThrow(
      'Only keys that allow sending traces can be synced',
    );

    expect(userId).toBeDefined();
  });

  it('keeps missing legacy permissions readable through the persisted key validator', async () => {
    const t = initConvexTest();
    const tokenIdentifier = 'https://auth.example/|auth0|api-key-permissions-legacy';
    const keyId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier,
        email: 'legacy@example.com',
        enabled: true,
      });
      const orgId = await ctx.db.insert('organizations', { name: 'Legacy', ownerId: userId });
      await ctx.db.patch(userId, { orgId });
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role: 'owner',
        status: 'active',
        joinedAt: 1,
      });
      return ctx.db.insert('apiKeys', {
        key: 'legacy-ingest-key',
        expiresAt: Date.now() + 60_000,
        userId,
        orgId,
      });
    });

    await expect(t.query(internal.apiKeys.getByIdInternal, { id: keyId })).resolves.toMatchObject({
      key: 'legacy-ingest-key',
    });
  });
});
