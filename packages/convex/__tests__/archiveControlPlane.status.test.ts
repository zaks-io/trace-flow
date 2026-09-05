import { describe, expect, it } from 'vitest';
import { api, internal } from '../_generated/api';
import { ARCHIVE_CAP_BYTES, ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS } from '../archiveLib';
import { asUser, enableArchive, enrollInput, seedWorld } from './archiveControlPlaneTest.setup';

describe('archive control plane status and lifecycle', () => {
  it('projects status by organization without crossing collector or organization boundaries', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const otherOwner = asUser(world, world.otherOwner);
    await owner.mutation(api.archive.activate, {});
    await otherOwner.mutation(api.archive.activate, {});

    await world.t.mutation(internal.archiveInternal.applyServerStatusByOrganization, {
      orgId: world.owner.orgId,
      revision: 1,
      storedBytes: 11,
      lifecycle: 'active',
    });
    await world.t.mutation(internal.archiveInternal.applyServerStatusByOrganization, {
      orgId: world.otherOwner.orgId,
      revision: 1,
      storedBytes: 22,
      lifecycle: 'blocked',
    });

    const statuses = await world.t.run(async (ctx) => ctx.db.query('archiveStatuses').collect());
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orgId: world.owner.orgId, storedBytes: 11, lifecycle: 'active' }),
        expect.objectContaining({
          orgId: world.otherOwner.orgId,
          storedBytes: 22,
          lifecycle: 'blocked',
        }),
      ]),
    );
  });

  it('lets collector heartbeats change only timestamped local fields', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await owner.mutation(api.archive.reportHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 42,
      localError: 'spool_full',
      observedAt: 1234,
    });
    const enrollment = (
      await world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect())
    )[0]!;
    expect(enrollment.pendingSpoolBytes).toBe(42);
    expect(enrollment.localError).toBe('spool_full');
    expect(enrollment.localObservedAt).toBe(1234);

    const before = (
      await world.t.run(async (ctx) => ctx.db.query('archiveStatuses').collect())
    )[0]!;
    await world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 7,
      observedAt: 5678,
    });
    const after = await world.t.run(async (ctx) => ctx.db.get(before._id));
    expect(after?.storedBytes).toBe(before.storedBytes);
    expect(after?.lifecycle).toBe(before.lifecycle);
    expect(after?.lastDurableAcknowledgedAt).toBe(before.lastDurableAcknowledgedAt);
  });

  it('rejects delayed heartbeat retries that reuse or regress the observation version', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await owner.mutation(api.archive.reportHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 10,
      localError: 'spool_full',
      observedAt: 2000,
    });
    await owner.mutation(api.archive.reportHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 10,
      localError: 'spool_full',
      observedAt: 2000,
    });
    await expect(
      owner.mutation(api.archive.reportHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 99,
        observedAt: 2000,
      }),
    ).rejects.toThrow('reused with a different payload');

    await owner.mutation(api.archive.reportHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 20,
      observedAt: 3000,
    });
    await expect(
      owner.mutation(api.archive.reportHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 10,
        localError: 'spool_full',
        observedAt: 2000,
      }),
    ).rejects.toThrow('Stale collector heartbeat observation');

    await world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 20,
      observedAt: 3000,
    });
    await expect(
      world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 1,
        observedAt: 2500,
      }),
    ).rejects.toThrow('Stale collector heartbeat observation');

    const enrollment = (
      await world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect())
    )[0]!;
    expect(enrollment.pendingSpoolBytes).toBe(20);
    expect(enrollment.localObservedAt).toBe(3000);
  });

  it('rejects poisoned future heartbeat observations while accepting legitimate clock skew', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    const legitimatelySkewedObservedAt = Date.now() + ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS - 1_000;
    await owner.mutation(api.archive.reportHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 11,
      observedAt: legitimatelySkewedObservedAt,
    });
    await expect(
      owner.mutation(api.archive.reportHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 99,
        observedAt: Date.now() + ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS * 2,
      }),
    ).rejects.toThrow('in the future');
    await expect(
      world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 99,
        observedAt: Date.now() + ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS * 2,
      }),
    ).rejects.toThrow('in the future');
    const enrollment = (
      await world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect())
    )[0]!;
    expect(enrollment.pendingSpoolBytes).toBe(11);
    expect(enrollment.localObservedAt).toBe(legitimatelySkewedObservedAt);
  });

  it('lets Archive API own durable acknowledgement, server bytes, and lifecycle', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 1,
      storedBytes: 99,
      lastDurableAcknowledgedAt: 888,
      lifecycle: 'blocked',
    });
    await world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
      sourceSessionId: 'sess-1',
      errorClass: 'chain_mismatch',
    });

    const status = await owner.query(api.archive.getStatus, {});
    expect(status.storedBytes).toBe(99);
    expect(status.lastDurableAcknowledgedAt).toBe(888);
    expect(status.lifecycle).toBe('blocked');
    expect(status.integritySessions).toEqual([
      expect.objectContaining({
        contributionId: enrolled.contributionId,
        source: 'claude',
        sourceSessionId: 'sess-1',
        errorClass: 'chain_mismatch',
      }),
    ]);

    const enrollment = (
      await world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect())
    )[0]!;
    expect(enrollment.pendingSpoolBytes).toBeUndefined();
  });

  it('rejects delayed server-status retries that reuse or regress the revision', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 1,
      storedBytes: 10,
      lastDurableAcknowledgedAt: 100,
      lifecycle: 'active',
    });
    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 1,
      storedBytes: 10,
      lastDurableAcknowledgedAt: 100,
      lifecycle: 'active',
    });
    await expect(
      world.t.mutation(internal.archiveInternal.applyServerStatus, {
        collectorCredentialId: world.ownerCred,
        revision: 1,
        storedBytes: 99,
        lastDurableAcknowledgedAt: 100,
        lifecycle: 'active',
      }),
    ).rejects.toThrow('reused with a different payload');

    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 2,
      storedBytes: 20,
      lastDurableAcknowledgedAt: 200,
      lifecycle: 'blocked',
    });
    await expect(
      world.t.mutation(internal.archiveInternal.applyServerStatus, {
        collectorCredentialId: world.ownerCred,
        revision: 1,
        storedBytes: 10,
        lastDurableAcknowledgedAt: 100,
        lifecycle: 'active',
      }),
    ).rejects.toThrow('Stale archive server status revision');

    const status = await owner.query(api.archive.getStatus, {});
    expect(status.storedBytes).toBe(20);
    expect(status.lastDurableAcknowledgedAt).toBe(200);
    expect(status.lifecycle).toBe('blocked');
  });

  it('accepts a rebased server status after entitlement sync changes lifecycle at the same revision', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await world.t.mutation(internal.archiveInternal.applyServerStatusByOrganization, {
      orgId: world.owner.orgId,
      revision: 1,
      storedBytes: 10,
      lifecycle: 'blocked',
    });

    await world.t.run(async (ctx) => {
      const subscription = (
        await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', world.owner.orgId))
          .collect()
      )[0]!;
      await ctx.db.patch(subscription._id, { status: 'canceled' });
    });
    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });
    await world.t.run(async (ctx) => {
      const subscription = (
        await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', world.owner.orgId))
          .collect()
      )[0]!;
      await ctx.db.patch(subscription._id, { status: 'active' });
    });
    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });

    const entitlementUpdated = await owner.query(api.archive.getStatus, {});
    expect(entitlementUpdated).toMatchObject({
      storedBytes: 10,
      lifecycle: 'active',
    });
    await expect(
      world.t.mutation(internal.archiveInternal.applyServerStatusByOrganization, {
        orgId: world.owner.orgId,
        revision: 1,
        storedBytes: 10,
        lifecycle: 'blocked',
      }),
    ).rejects.toThrow('reused with a different payload');
    await expect(
      world.t.mutation(internal.archiveInternal.applyServerStatusByOrganization, {
        orgId: world.owner.orgId,
        revision: 2,
        storedBytes: 10,
        lifecycle: 'blocked',
      }),
    ).resolves.toEqual({ revision: 2, replay: false });
    expect(await owner.query(api.archive.getStatus, {})).toMatchObject({
      storedBytes: 10,
      lifecycle: 'blocked',
    });
  });

  it('keys session integrity by contribution and never reassigns ownership on collision', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);
    await owner.mutation(api.archive.activate, {});
    const ownerEnroll = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    const memberEnroll = await member.mutation(api.archive.enroll, enrollInput(world.memberCred));

    const ownerRow = await world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
      sourceSessionId: 'shared-session',
      errorClass: 'owner_gap',
    });
    const memberRow = await world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
      collectorCredentialId: world.memberCred,
      source: 'claude',
      sourceSessionId: 'shared-session',
      errorClass: 'member_gap',
    });
    expect(ownerRow.contributionId).toBe(ownerEnroll.contributionId);
    expect(memberRow.contributionId).toBe(memberEnroll.contributionId);
    expect(ownerRow.contributionId).not.toBe(memberRow.contributionId);

    const ownerReplay = await world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
      sourceSessionId: 'shared-session',
      errorClass: 'owner_repaired',
    });
    expect(ownerReplay.contributionId).toBe(ownerEnroll.contributionId);

    const rows = await world.t.run(async (ctx) =>
      ctx.db.query('archiveSessionIntegrity').collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.contributionId).sort()).toEqual(
      [ownerEnroll.contributionId, memberEnroll.contributionId].sort(),
    );
    expect(rows.every((row) => row.sourceSessionId === 'shared-session')).toBe(true);

    const memberStatus = await member.query(api.archive.getStatus, {});
    expect(memberStatus.integritySessions).toEqual([
      expect.objectContaining({
        contributionId: memberEnroll.contributionId,
        sourceSessionId: 'shared-session',
        errorClass: 'member_gap',
      }),
    ]);

    const ownerStatus = await owner.query(api.archive.getStatus, {});
    expect(ownerStatus.integritySessions).toHaveLength(2);
    expect(ownerStatus.integritySessions.map((row) => row.contributionId).sort()).toEqual(
      [ownerEnroll.contributionId, memberEnroll.contributionId].sort(),
    );
  });

  it('does not let enrollment overwrite Archive API lifecycle or durable bytes', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 1,
      storedBytes: ARCHIVE_CAP_BYTES,
      lastDurableAcknowledgedAt: 999,
      lifecycle: 'blocked',
    });

    await member.mutation(api.archive.enroll, enrollInput(world.memberCred));

    const status = await owner.query(api.archive.getStatus, {});
    expect(status.lifecycle).toBe('blocked');
    expect(status.storedBytes).toBe(ARCHIVE_CAP_BYTES);
    expect(status.lastDurableAcknowledgedAt).toBe(999);
    expect(status.enrolledCollectorCount).toBe(2);
  });

  it('preserves deleting through billing sync after entitlement is regained', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 1,
      storedBytes: 50,
      lastDurableAcknowledgedAt: 111,
      lifecycle: 'deleting',
    });

    const deniedWhileDeleting = await world.t.query(
      internal.archiveInternal.authorizeArchiveWrite,
      {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      },
    );
    expect(deniedWhileDeleting).toEqual({ allowed: false, reason: 'deleting' });

    await world.t.run(async (ctx) => {
      const subscription = (
        await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', world.owner.orgId))
          .collect()
      )[0]!;
      await ctx.db.patch(subscription._id, { status: 'canceled' });
    });
    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });
    await world.t.run(async (ctx) => {
      const subscription = (
        await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', world.owner.orgId))
          .collect()
      )[0]!;
      await ctx.db.patch(subscription._id, { status: 'active' });
    });
    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });

    const activation = (
      await world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect())
    )[0]!;
    expect(activation.status).toBe('deleting');
    const status = await owner.query(api.archive.getStatus, {});
    expect(status.lifecycle).toBe('deleting');
    expect(status.storedBytes).toBe(50);
    expect(status.lastDurableAcknowledgedAt).toBe(111);

    const stillDenied = await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
    });
    expect(stillDenied).toEqual({ allowed: false, reason: 'deleting' });
  });

  it('repairs duplicate enrollment slots without throwing on later reads', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const first = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await world.t.run(async (ctx) => {
      const extraEnrollment = await ctx.db.insert('archiveEnrollments', {
        orgId: world.owner.orgId,
        userId: world.owner._id,
        collectorCredentialId: world.ownerCred,
        collectorId: 'collector-owner',
        contributionId: first.contributionId,
        idempotencyKey: `consent:${world.ownerCred}:extra`,
        consentSources: [{ source: 'codex', historyChoice: 'all_history' }],
        authorizedSources: [{ source: 'codex', historyChoice: 'all_history', authorizedAt: 1 }],
        status: 'active',
        createdAt: Date.now(),
      });
      await ctx.db.insert('archiveEnrollmentSlots', {
        orgId: world.owner.orgId,
        collectorCredentialId: world.ownerCred,
        currentEnrollmentId: extraEnrollment,
      });
    });

    const replay = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    expect(replay.enrollmentId).toBe(first.enrollmentId);
    expect(replay.created).toBe(false);
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveEnrollmentSlots').collect()),
    ).resolves.toHaveLength(1);

    const allowed = await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
    });
    expect(allowed).toMatchObject({ allowed: true, enrollmentId: first.enrollmentId });
  });

  it('keeps deleting terminal when entitlement syncs again', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 1,
      lifecycle: 'deleting',
    });

    const activation = (
      await world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect())
    )[0]!;
    expect(activation.status).toBe('deleting');
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });

    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });
    expect((await world.t.run(async (ctx) => ctx.db.get(activation._id)))?.status).toBe('deleting');
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });

    await world.t.run(async (ctx) => {
      const subscription = (
        await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', world.owner.orgId))
          .collect()
      )[0]!;
      await ctx.db.patch(subscription._id, { status: 'canceled' });
    });
    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });
    const stillDeleting = await world.t.run(async (ctx) => ctx.db.get(activation._id));
    expect(stillDeleting?.status).toBe('deleting');
    expect(stillDeleting?.graceDeadlineAt).toBeUndefined();
  });

  it('does not let applyServerStatus overwrite entitlement-derived frozen or deleting', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await world.t.run(async (ctx) => {
      const subscription = (
        await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', world.owner.orgId))
          .collect()
      )[0]!;
      await ctx.db.patch(subscription._id, { status: 'canceled' });
    });
    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });
    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 2,
      storedBytes: 12,
      lastDurableAcknowledgedAt: 222,
      lifecycle: 'active',
    });
    const frozenStatus = await owner.query(api.archive.getStatus, {});
    expect(frozenStatus.lifecycle).toBe('frozen');
    expect(frozenStatus.storedBytes).toBe(12);
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'frozen' });

    await world.t.run(async (ctx) => {
      const subscription = (
        await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', world.owner.orgId))
          .collect()
      )[0]!;
      await ctx.db.patch(subscription._id, { status: 'active' });
    });
    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });
    await world.t.mutation(internal.archiveInternal.applyServerStatus, {
      collectorCredentialId: world.ownerCred,
      revision: 3,
      lifecycle: 'deleting',
    });
    await expect(
      world.t.mutation(internal.archiveInternal.applyServerStatus, {
        collectorCredentialId: world.ownerCred,
        revision: 4,
        lifecycle: 'active',
      }),
    ).rejects.toThrow('deleting');
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });
    expect((await owner.query(api.archive.getStatus, {})).lifecycle).toBe('deleting');
  });
});
