import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import { ensureOrgHasSubscription } from '../auth/organizations';
import { initConvexTest } from './convexTest.setup';

describe('deleted organization authorization', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('allows a live member and rejects every mint boundary once deletion starts', async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const tokenIdentifier = 'https://auth.example/|auth0|lifecycle-user';
    const { userId, orgId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier,
        email: 'lifecycle@example.com',
        enabled: true,
      });
      const orgId = await ctx.db.insert('organizations', {
        name: 'Lifecycle org',
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
      return { userId, orgId };
    });
    const asUser = t.withIdentity({ tokenIdentifier });

    await expect(
      asUser.mutation(api.apiKeys.create, {
        expiresAt: Date.now() + 60_000,
        name: 'live control',
      }),
    ).resolves.toBeDefined();
    await expect(
      t.query(internal.collectorLogin.resolveLoginOrg, { userId }),
    ).resolves.toMatchObject({ orgId });
    await expect(
      t.query(internal.bodyAccess.authorizeSubject, {
        userId,
        orgId,
        sub: 'auth0|lifecycle-user',
      }),
    ).resolves.toBe(true);

    await t.run((ctx) => ctx.db.patch(orgId, { deletionStartedAt: Date.now() }));

    await expect(
      asUser.mutation(api.apiKeys.create, {
        expiresAt: Date.now() + 60_000,
        name: 'stale org',
      }),
    ).rejects.toThrow('Active organization membership required');
    await expect(
      t.mutation(internal.collectorLogin.mintForUser, {
        userId,
        collectorId: 'collector',
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow('Active organization membership required');
    await expect(t.query(internal.collectorLogin.resolveLoginOrg, { userId })).resolves.toBeNull();
    await expect(
      t.query(internal.bodyAccess.authorizeSubject, {
        userId,
        orgId,
        sub: 'auth0|lifecycle-user',
      }),
    ).resolves.toBe(false);
    await expect(asUser.action(api.integrations.tinybird.generateWebReadToken, {})).rejects.toThrow(
      'Active organization membership required',
    );
  });

  it('does not recreate billing for an organization being deleted', async () => {
    const query = vi.fn();
    const ctx = {
      db: {
        get: vi.fn().mockResolvedValue({
          _id: 'deleted-org',
          name: 'Deleted',
          ownerId: 'owner',
          deletionStartedAt: 1,
        }),
        query,
      },
    };

    await expect(ensureOrgHasSubscription(ctx as never, 'deleted-org' as never)).rejects.toThrow(
      'Organization is not active',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('never exposes peer secrets and revokes only the removed member credentials', async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const ownerToken = 'https://auth.example/|auth0|key-owner';
    const memberToken = 'https://auth.example/|auth0|key-member';
    const { orgId, memberId, memberMembershipId } = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert('users', {
        tokenIdentifier: ownerToken,
        email: 'key-owner@example.com',
        enabled: true,
      });
      const memberId = await ctx.db.insert('users', {
        tokenIdentifier: memberToken,
        email: 'key-member@example.com',
        enabled: true,
      });
      const orgId = await ctx.db.insert('organizations', {
        name: 'Key rotation org',
        ownerId,
      });
      await Promise.all([ctx.db.patch(ownerId, { orgId }), ctx.db.patch(memberId, { orgId })]);
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId: ownerId,
        role: 'owner',
        status: 'active',
        joinedAt: 1,
      });
      const memberMembershipId = await ctx.db.insert('organizationMembers', {
        orgId,
        userId: memberId,
        role: 'member',
        status: 'active',
        joinedAt: 1,
      });
      await ctx.db.insert('apiKeys', {
        key: 'owner-secret',
        expiresAt: Date.now() + 60_000,
        userId: ownerId,
        orgId,
        name: 'Owner key',
      });
      await ctx.db.insert('apiKeys', {
        key: 'member-secret',
        expiresAt: Date.now() + 60_000,
        userId: memberId,
        orgId,
        name: 'Member key',
      });
      return { orgId, memberId, memberMembershipId };
    });

    const owner = t.withIdentity({ tokenIdentifier: ownerToken });
    const member = t.withIdentity({ tokenIdentifier: memberToken });
    await expect(owner.query(api.apiKeys.list, {})).resolves.toMatchObject([
      { key: 'owner-secret' },
    ]);
    await expect(member.query(api.apiKeys.list, {})).resolves.toMatchObject([
      { key: 'member-secret' },
    ]);
    await expect(member.query(api.apiKeys.getByKey, { key: 'owner-secret' })).resolves.toBeNull();
    await expect(member.query(api.apiKeys.listAnalytics, {})).resolves.toHaveLength(2);
    await expect(
      t.query(internal.bodyAccess.authorizeSubject, {
        userId: memberId,
        orgId,
        sub: 'auth0|key-member',
      }),
    ).resolves.toBe(true);
    const alertSettings = await member.query(api.costAlerts.listForCurrentOrg, {});
    expect(alertSettings.apiKeys).toHaveLength(2);
    expect(alertSettings.apiKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Owner key',
          identifier: expect.stringMatching(/^sha256:/),
        }),
        expect.objectContaining({
          name: 'Member key',
          identifier: expect.stringMatching(/^sha256:/),
        }),
      ]),
    );
    expect(JSON.stringify(alertSettings.apiKeys)).not.toContain('owner-secret');
    expect(JSON.stringify(alertSettings.apiKeys)).not.toContain('member-secret');
    await expect(
      t.action(internal.integrations.tinybird.authorizePipesQuery, {
        userId: memberId,
        orgId,
        pipe: 'traces_list',
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });

    await owner.mutation(api.auth.users.removeMember, { memberId: memberMembershipId });

    await expect(owner.query(api.apiKeys.list, {})).resolves.toMatchObject([
      { key: 'owner-secret' },
    ]);
    await expect(member.query(api.apiKeys.list, {})).resolves.toEqual([]);
    await expect(member.query(api.apiKeys.getByKey, { key: 'owner-secret' })).resolves.toBeNull();
    await expect(
      t.query(internal.bodyAccess.authorizeSubject, {
        userId: memberId,
        orgId,
        sub: 'auth0|key-member',
      }),
    ).resolves.toBe(false);
    await expect(
      t.action(internal.integrations.tinybird.authorizePipesQuery, {
        userId: memberId,
        orgId,
        pipe: 'traces_list',
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(internal.integrations.cloudflare.getApiKeySyncData, { key: 'owner-secret' }),
    ).resolves.toMatchObject({ key: 'owner-secret' });
    await expect(
      t.query(internal.integrations.cloudflare.getApiKeySyncData, { key: 'member-secret' }),
    ).resolves.toBeNull();
    const keys = await t.run((ctx) =>
      ctx.db
        .query('apiKeys')
        .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
        .collect(),
    );
    expect(keys).toMatchObject([{ key: 'owner-secret' }]);
  });

  it('detaches users and removes active memberships during retryable deletion batches', async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const { userId, orgId, membershipId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier: 'https://auth.example/|auth0|deleted-member',
        email: 'deleted-member@example.com',
        enabled: true,
      });
      const orgId = await ctx.db.insert('organizations', {
        name: 'Deleting org',
        ownerId: userId,
      });
      const inviteId = await ctx.db.insert('invites', {
        email: 'deleted-member@example.com',
        orgId,
        invitedBy: userId,
        status: 'accepted',
        token: 'accepted-token',
        expiresAt: Date.now() + 60_000,
      });
      await ctx.db.patch(userId, { orgId, inviteId });
      const membershipId = await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role: 'owner',
        status: 'active',
        joinedAt: 1,
      });
      return { userId, orgId, membershipId };
    });

    const result = await t.mutation(internal.admin.admin.deleteOrgRecordsBatch, { orgId });

    expect(result.counts.membersRemoved).toBe(1);
    const [user, membership] = await t.run((ctx) =>
      Promise.all([ctx.db.get(userId), ctx.db.get(membershipId)]),
    );
    expect(user).toMatchObject({ enabled: true });
    expect(user?.orgId).toBeUndefined();
    expect(user?.inviteId).toBeUndefined();
    expect(membership).toMatchObject({ status: 'removed' });
  });

  it('cancels and deletes every cost-alert record during organization deletion', async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const { orgId, alertId, channelId, schedulerId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier: 'https://auth.example/|auth0|cost-alert-deletion',
        email: 'cost-alert-deletion@example.com',
        enabled: true,
      });
      const orgId = await ctx.db.insert('organizations', {
        name: 'Cost alert deletion org',
        ownerId: userId,
      });
      const channelId = await ctx.db.insert('costAlertChannels', {
        orgId,
        name: 'Secret webhook',
        enabled: true,
        config: {
          type: 'webhook',
          url: 'https://alerts.example.com/hook',
          secret: 'stored-webhook-secret',
        },
        createdByUserId: userId,
        createdAt: 1,
        updatedAt: 1,
      });
      const alertId = await ctx.db.insert('costAlerts', {
        orgId,
        name: 'Spend alert',
        enabled: true,
        severity: 'warning',
        channelIds: [channelId],
        cooldownMinutes: 60,
        notifyOnRecovery: true,
        condition: { type: 'absolute_spend_threshold', window: 'last_hour', thresholdUsd: 1 },
        createdByUserId: userId,
        updatedByUserId: userId,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('costAlertStates', {
        orgId,
        costAlertId: alertId,
        active: true,
        lastEvaluatedAt: 1,
      });
      await ctx.db.insert('costAlertDeliveries', {
        orgId,
        costAlertId: alertId,
        channelId,
        eventType: 'triggered',
        status: 'success',
        idempotencyKey: 'deletion-delivery',
        payloadSummary: 'Triggered',
        attemptedAt: 1,
      });
      const schedulerId = await ctx.scheduler.runAfter(
        60_000,
        internal.integrations.costAlerts.evaluateOrg,
        { orgId },
      );
      await ctx.db.insert('costAlertMonitors', {
        orgId,
        schedulerId,
        nextEvaluationAt: Date.now() + 60_000,
      });
      return { orgId, alertId, channelId, schedulerId };
    });

    let batch = await t.mutation(internal.admin.admin.deleteOrgRecordsBatch, { orgId });
    while (batch.hasMore) {
      batch = await t.mutation(internal.admin.admin.deleteOrgRecordsBatch, { orgId });
    }

    const deletedRows = await t.run(async (ctx) => ({
      channels: await ctx.db
        .query('costAlertChannels')
        .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
        .collect(),
      alerts: await ctx.db
        .query('costAlerts')
        .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
        .collect(),
      states: await ctx.db
        .query('costAlertStates')
        .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
        .collect(),
      deliveries: await ctx.db
        .query('costAlertDeliveries')
        .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
        .collect(),
      monitors: await ctx.db
        .query('costAlertMonitors')
        .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
        .collect(),
      scheduled: await ctx.db.system.get(schedulerId),
    }));
    expect(deletedRows).toMatchObject({
      channels: [],
      alerts: [],
      states: [],
      deliveries: [],
      monitors: [],
      scheduled: { state: { kind: 'canceled' } },
    });

    await expect(
      t.mutation(internal.costAlerts.recordState, {
        orgId,
        costAlertId: alertId,
        active: false,
        lastEvaluatedAt: 2,
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(internal.costAlerts.recordDelivery, {
        orgId,
        costAlertId: alertId,
        channelId,
        eventType: 'triggered',
        status: 'failed',
        idempotencyKey: 'late-deletion-delivery',
        payloadSummary: 'Late delivery',
        attemptedAt: 2,
      }),
    ).resolves.toBeNull();
    await t.mutation(internal.costAlerts.syncMonitor, { orgId, delayMs: 1 });
    const lateRows = await t.run(async (ctx) =>
      Promise.all([
        ctx.db
          .query('costAlertStates')
          .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
          .collect(),
        ctx.db
          .query('costAlertDeliveries')
          .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
          .collect(),
        ctx.db
          .query('costAlertMonitors')
          .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
          .collect(),
      ]),
    );
    expect(lateRows).toEqual([[], [], []]);
  });

  it('turns stale KV sync retries into deletions after organization deletion starts', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
    vi.stubEnv('CLOUDFLARE_KV_NAMESPACE_ID', 'api-namespace');
    vi.stubEnv('CLOUDFLARE_COLLECTOR_CREDS_NAMESPACE_ID', 'collector-namespace');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = initConvexTest();
    const now = Date.now();
    const { userId, orgId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier: 'https://auth.example/|auth0|kv-retry',
        email: 'kv-retry@example.com',
        enabled: true,
      });
      const orgId = await ctx.db.insert('organizations', {
        name: 'Deleting KV org',
        ownerId: userId,
        deletionStartedAt: now,
      });
      await ctx.db.patch(userId, { orgId });
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role: 'owner',
        status: 'active',
        joinedAt: now,
      });
      await ctx.db.insert('apiKeys', {
        key: 'stale-api-key',
        expiresAt: now + 60_000,
        userId,
        orgId,
      });
      await ctx.db.insert('collectorCredentials', {
        hashedSecret: 'stale-collector-hash',
        orgId,
        userId,
        collectorId: 'collector',
        status: 'active',
        expiresAt: now + 60_000,
      });
      await ctx.db.insert('subscriptions', {
        orgId,
        tier: 'hobby',
        status: 'active',
        monthlyUnits: 1_000,
        addonUnits: 0,
        currentPeriodStart: now,
        currentPeriodEnd: now + 60_000,
        currentPeriodOverageSpentCents: 0,
        addonPurchaseCount: 0,
      });
      return { userId, orgId };
    });

    await t.action(internal.integrations.cloudflare.syncKeyToKV, {
      key: 'stale-api-key',
      expiresAt: now + 60_000,
      orgId,
    });
    await t.action(internal.integrations.cloudflare.syncCollectorCredToKV, {
      hashedSecret: 'stale-collector-hash',
      orgId,
      userId,
      collectorId: 'collector',
      expiresAt: now + 60_000,
      status: 'active',
      createdAt: now,
    });
    await t.action(internal.integrations.cloudflare.syncSubscriptionToKV, {
      orgId,
      tier: 'hobby',
      monthlyUnits: 1_000,
      addonUnits: 0,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: now + 60_000,
    });
    await t.action(internal.integrations.cloudflare.syncUserOrgToKV, {
      sub: 'auth0|kv-retry',
      userId,
      orgId,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === 'DELETE')).toBe(true);
  });
});
