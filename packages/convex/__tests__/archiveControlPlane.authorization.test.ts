import { describe, expect, it } from 'vitest';
import { api, internal } from '../_generated/api';
import { beginArchiveDeletion } from '../archiveLib';
import {
  asUser,
  disableArchive,
  enableArchive,
  enrollInput,
  seedWorld,
} from './archiveControlPlaneTest.setup';

describe('archive control plane write authorization', () => {
  it('revalidates credential, enrollment, and Source before session integrity writes', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await expect(
      world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
        collectorCredentialId: world.ownerCred,
        source: 'codex',
        sourceSessionId: 'sess-unauthorized',
      }),
    ).rejects.toThrow('Source is not authorized');

    await owner.mutation(api.archive.unenroll, { enrollmentId: enrolled.enrollmentId });
    await expect(
      world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
        sourceSessionId: 'sess-after-unenroll',
      }),
    ).rejects.toThrow('Enrollment is not active');
    expect(
      await world.t.run(async (ctx) => ctx.db.query('archiveSessionIntegrity').collect()),
    ).toHaveLength(0);

    await owner.mutation(
      api.archive.enroll,
      enrollInput(world.ownerCred, { idempotencyKey: `consent:${world.ownerCred}:renew` }),
    );
    await world.t.run(async (ctx) => {
      await ctx.db.patch(world.ownerCred, { status: 'revoked' });
    });
    await expect(
      world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
        sourceSessionId: 'sess-revoked',
      }),
    ).rejects.toThrow('Collector Credential is not active');
  });

  it('rejects archive writes after org deletion marks the archive deleting', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await world.t.run(async (ctx) => {
      await ctx.db.insert('apiKeys', {
        key: 'org-delete-pending',
        expiresAt: Date.now() + 60_000,
        orgId: world.owner.orgId,
        userId: world.owner._id,
        name: 'pending',
      });
      await beginArchiveDeletion(ctx, world.owner.orgId, Date.now());
    });
    expect(
      (await world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect()))[0]?.status,
    ).toBe('deleting');
    expect(await world.t.run(async (ctx) => ctx.db.get(world.ownerCred))).toMatchObject({
      status: 'active',
    });

    await expect(
      owner.mutation(api.archive.reportHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 1,
        observedAt: 9,
      }),
    ).rejects.toThrow('deleting');
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });
    await expect(
      world.t.mutation(internal.archiveInternal.applyServerStatus, {
        collectorCredentialId: world.ownerCred,
        revision: 9,
        storedBytes: 1,
        lifecycle: 'active',
      }),
    ).rejects.toThrow('deleting');
    await expect(
      world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 1,
        observedAt: 9,
      }),
    ).rejects.toThrow('deleting');
    await expect(
      world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
        sourceSessionId: 'sess-during-org-delete',
      }),
    ).rejects.toThrow('deleting');
  });

  it('denies archive writes while deletion persists until final org deletion', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await world.t.mutation(internal.admin.admin.beginOrgDeletion, {
      orgId: world.owner.orgId,
    });
    const deleting = await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId));
    expect(deleting?.deletionStartedAt).toEqual(expect.any(Number));
    expect(deleting?.deletedAt).toBeUndefined();
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });
    await expect(
      owner.mutation(api.archive.reportHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 1,
        observedAt: 9,
      }),
    ).rejects.toThrow('deleting');

    await world.t.mutation(internal.admin.admin.finalizeOrgDeletion, {
      orgId: world.owner.orgId,
    });
    const finalized = await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId));
    expect(finalized?.deletedAt).toEqual(expect.any(Number));
    expect(finalized?.deletionStartedAt).toBeUndefined();
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });
    await expect(
      world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 2,
        observedAt: 10,
      }),
    ).rejects.toThrow('Organization not found');
  });

  it('persists the deletion marker while archive rows are removed in batches', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await world.t.run(async (ctx) => {
      for (let index = 0; index < 501; index++) {
        await ctx.db.insert('apiKeys', {
          key: `archive-batch-${index}`,
          expiresAt: Date.now() + 60_000,
          orgId: world.owner.orgId,
          userId: world.owner._id,
          name: 'batch-test',
        });
      }
    });

    await world.t.mutation(internal.admin.admin.beginOrgDeletion, {
      orgId: world.owner.orgId,
    });
    const marker = (await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId)))!
      .deletionStartedAt;
    expect(marker).toEqual(expect.any(Number));

    let batches = 0;
    let batch = await world.t.mutation(internal.admin.admin.deleteOrgRecordsBatch, {
      orgId: world.owner.orgId,
    });
    batches++;
    expect(batch.hasMore).toBe(true);
    expect(
      (await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId)))?.deletionStartedAt,
    ).toBe(marker);
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });

    while (batch.hasMore) {
      batch = await world.t.mutation(internal.admin.admin.deleteOrgRecordsBatch, {
        orgId: world.owner.orgId,
      });
      batches++;
    }
    expect(batches).toBeGreaterThan(1);
    expect(
      (await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId)))?.deletionStartedAt,
    ).toBe(marker);
    expect(await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId))).not.toMatchObject({
      deletedAt: expect.any(Number),
    });
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect()),
    ).resolves.toHaveLength(0);

    await world.t.mutation(internal.admin.admin.finalizeOrgDeletion, {
      orgId: world.owner.orgId,
    });
    expect(
      (await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId)))?.deletionStartedAt,
    ).toBe(undefined);
  });

  it('lets public collector heartbeats continue while the archive is frozen', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

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
    expect(
      (await world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect()))[0]?.status,
    ).toBe('frozen');
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'frozen' });
    await expect(owner.mutation(api.archive.enroll, enrollInput(world.ownerCred))).rejects.toThrow(
      'frozen',
    );
    await expect(
      owner.mutation(api.archive.addAuthorizedSource, {
        enrollmentId: enrolled.enrollmentId,
        source: 'codex',
        historyChoice: 'new_only',
      }),
    ).rejects.toThrow('frozen');

    await owner.mutation(api.archive.reportHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 64,
      localError: 'grace_spool',
      observedAt: 4242,
    });
    const afterPublic = await world.t.run(async (ctx) => ctx.db.get(enrolled.enrollmentId));
    expect(afterPublic?.pendingSpoolBytes).toBe(64);
    expect(afterPublic?.localError).toBe('grace_spool');
    expect(afterPublic?.localObservedAt).toBe(4242);

    await world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 65,
      localError: 'grace_spool',
      observedAt: 4243,
    });
    const enrollment = await world.t.run(async (ctx) => ctx.db.get(enrolled.enrollmentId));
    expect(enrollment?.pendingSpoolBytes).toBe(65);
    expect(enrollment?.localObservedAt).toBe(4243);
  });

  it('rejects archive writes when the organization document is gone', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await world.t.run(async (ctx) => {
      await ctx.db.delete(world.owner.orgId);
    });
    expect(await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId))).toBeNull();
    expect(
      (await world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect()))[0]?.status,
    ).toBe('active');

    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });
    await expect(
      world.t.mutation(internal.archiveInternal.applyServerStatus, {
        collectorCredentialId: world.ownerCred,
        revision: 11,
        storedBytes: 1,
        lifecycle: 'active',
      }),
    ).rejects.toThrow('Organization not found');
    await expect(
      world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 1,
        observedAt: 11,
      }),
    ).rejects.toThrow('Organization not found');
    await expect(
      world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
        sourceSessionId: 'sess-after-org-row-gone',
      }),
    ).rejects.toThrow('Organization not found');
  });

  it('fails closed on internal archive writes when the server gate is off', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    disableArchive();

    await expect(
      world.t.mutation(internal.archiveInternal.applyServerStatus, {
        collectorCredentialId: world.ownerCred,
        revision: 12,
        storedBytes: 1,
        lifecycle: 'active',
      }),
    ).rejects.toThrow('not enabled');
    await expect(
      world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 1,
        observedAt: 12,
      }),
    ).rejects.toThrow('not enabled');
    await expect(
      world.t.mutation(internal.archiveInternal.upsertSessionIntegrity, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
        sourceSessionId: 'sess-after-kill-switch',
      }),
    ).rejects.toThrow('not enabled');
  });

  it('rejects internal collector heartbeats after the credential is revoked', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await world.t.run(async (ctx) => {
      await ctx.db.patch(world.ownerCred, { status: 'revoked' });
    });

    await expect(
      world.t.mutation(internal.archiveInternal.reportCollectorHeartbeat, {
        collectorCredentialId: world.ownerCred,
        pendingSpoolBytes: 99,
        observedAt: 13,
      }),
    ).rejects.toThrow('Collector Credential is not active');
    const enrollment = await world.t.run(async (ctx) => ctx.db.get(enrolled.enrollmentId));
    expect(enrollment?.pendingSpoolBytes).toBeUndefined();
  });

  it('authorizes a hashed-secret write only for the matching enrolled Collector and Source', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    const allowed = await world.t.query(
      internal.archiveInternal.authorizeArchiveWriteByHashedSecret,
      {
        hashedSecret: 'hash-owner',
        source: 'claude',
        orgId: world.owner.orgId,
        userId: world.owner._id,
        collectorId: 'collector-owner',
        now: Date.now(),
      },
    );
    expect(allowed).toMatchObject({
      allowed: true,
      contributionId: enrolled.contributionId,
      collectorCredentialId: world.ownerCred,
      orgId: world.owner.orgId,
      userId: world.owner._id,
    });

    const crossUser = await world.t.query(
      internal.archiveInternal.authorizeArchiveWriteByHashedSecret,
      {
        hashedSecret: 'hash-owner',
        source: 'claude',
        orgId: world.owner.orgId,
        userId: world.member._id,
        collectorId: 'collector-owner',
        now: Date.now(),
      },
    );
    expect(crossUser).toEqual({ allowed: false, reason: 'not_enrolled' });

    const crossOrg = await world.t.query(
      internal.archiveInternal.authorizeArchiveWriteByHashedSecret,
      {
        hashedSecret: 'hash-owner',
        source: 'claude',
        orgId: world.otherOwner.orgId,
        userId: world.owner._id,
        collectorId: 'collector-owner',
        now: Date.now(),
      },
    );
    expect(crossOrg).toEqual({ allowed: false, reason: 'not_enrolled' });
  });

  it('lets unenrollment win a later hashed-secret archive authorization', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await owner.mutation(api.archive.unenroll, { enrollmentId: enrolled.enrollmentId });

    const denied = await world.t.query(
      internal.archiveInternal.authorizeArchiveWriteByHashedSecret,
      {
        hashedSecret: 'hash-owner',
        source: 'claude',
        orgId: world.owner.orgId,
        userId: world.owner._id,
        collectorId: 'collector-owner',
        now: Date.now(),
      },
    );
    expect(denied).toEqual({ allowed: false, reason: 'enrollment_invalid' });
  });

  it('rejects a hashed-secret write when the Collector Credential has expired', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await world.t.run(async (ctx) => {
      await ctx.db.patch(world.ownerCred, { expiresAt: 1_000 });
    });

    const unexpired = await world.t.query(
      internal.archiveInternal.authorizeArchiveWriteByHashedSecret,
      {
        hashedSecret: 'hash-owner',
        source: 'claude',
        orgId: world.owner.orgId,
        userId: world.owner._id,
        collectorId: 'collector-owner',
        now: 999,
      },
    );
    expect(unexpired).toMatchObject({
      allowed: true,
      contributionId: enrolled.contributionId,
      collectorCredentialId: world.ownerCred,
    });

    const denied = await world.t.query(
      internal.archiveInternal.authorizeArchiveWriteByHashedSecret,
      {
        hashedSecret: 'hash-owner',
        source: 'claude',
        orgId: world.owner.orgId,
        userId: world.owner._id,
        collectorId: 'collector-owner',
        now: 1_000,
      },
    );
    expect(denied).toEqual({ allowed: false, reason: 'credential_revoked' });
  });
});
