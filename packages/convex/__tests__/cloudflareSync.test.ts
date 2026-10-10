import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import { initConvexTest } from './convexTest.setup';

beforeEach(() => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  vi.stubEnv('CLOUDFLARE_KV_NAMESPACE_ID', 'subscription-namespace');
  vi.stubEnv('CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID', 'collector-namespace');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Cloudflare live KV sync', () => {
  it('resyncs subscriptions and active collector credentials with their existing payloads', async () => {
    const t = initConvexTest();
    const tokenIdentifier = 'https://auth.example/|auth0|kv-admin';
    const orgId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier,
        email: 'kv-admin@example.com',
        enabled: true,
        isAdmin: true,
      });
      const orgId = await ctx.db.insert('organizations', { name: 'KV org', ownerId: userId });
      await ctx.db.patch(userId, { orgId });
      await ctx.db.insert('subscriptions', {
        orgId,
        tier: 'pro',
        status: 'active',
        monthlyUnits: 50_000,
        addonUnits: 10_000,
        currentPeriodStart: 100,
        currentPeriodEnd: 200,
        currentPeriodOverageSpentCents: 0,
        addonPurchaseCount: 1,
        autoOverage: true,
        overageCapCents: 500,
        cancelAtPeriodEnd: true,
      });
      await ctx.db.insert('apiKeys', {
        key: 'unread-mirror',
        userId,
        orgId,
        expiresAt: Date.now() + 60_000,
      });
      for (const status of ['active', 'revoked'] as const) {
        await ctx.db.insert('collectorCredentials', {
          orgId,
          userId,
          hashedSecret: `${status}-hash`,
          collectorId: 'collector',
          status,
        });
      }
      return orgId;
    });

    await expect(
      t.withIdentity({ tokenIdentifier }).action(api.integrations.cloudflare.syncAll, {}),
    ).resolves.toEqual({ subSynced: 1, collectorCredSynced: 1 });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    const subscription = calls.find(([url]) => String(url).includes('subscription-namespace'))!;
    expect(decodeURIComponent(String(subscription[0]))).toContain(`/values/sub:${orgId}`);
    expect(subscription[1]?.method).toBe('PUT');
    expect(JSON.parse(subscription[1]?.body as string)).toEqual({
      tier: 'pro',
      status: 'active',
      monthlyUnits: 50_000,
      addonUnits: 10_000,
      currentPeriodStart: 100,
      currentPeriodEnd: 200,
      autoOverage: true,
      overageCapCents: 500,
      cancelAtPeriodEnd: true,
    });
    const collector = calls.find(([url]) => String(url).includes('collector-namespace'))!;
    expect(decodeURIComponent(String(collector[0]))).toContain('/values/collector:active-hash');
    expect(collector[1]?.method).toBe('PUT');
    expect(JSON.parse(collector[1]?.body as string)).toMatchObject({
      orgId,
      collectorId: 'collector',
      status: 'active',
      createdAt: expect.any(Number),
      userId: expect.any(String),
    });
  });

  it('checks the subscription key for admin activation and reports missing records', async () => {
    const t = initConvexTest();
    const orgId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert('users', {
        tokenIdentifier: 'kv-owner',
        email: 'kv-owner@example.com',
        enabled: true,
      });
      return ctx.db.insert('organizations', { name: 'KV org', ownerId });
    });
    await expect(
      t.action(internal.integrations.cloudflare.checkSubscriptionInKV, { orgId }),
    ).resolves.toBe(true);
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    expect(decodeURIComponent(String(url))).toContain(`/values/sub:${orgId}`);
    expect(request?.method).toBe('GET');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(
      t.action(internal.integrations.cloudflare.checkSubscriptionInKV, { orgId }),
    ).resolves.toBe(false);
  });
});
