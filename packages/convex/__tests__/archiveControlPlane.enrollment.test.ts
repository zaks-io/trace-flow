import { describe, expect, it } from 'vitest';
import { api, internal } from '../_generated/api';
import { ARCHIVE_CAP_BYTES, ARCHIVE_GRACE_MS } from '../archiveLib';
import {
  asUser,
  disableArchive,
  enableArchive,
  enrollInput,
  otherSources,
  seedWorld,
} from './archiveControlPlaneTest.setup';

describe('archive control plane enrollment', () => {
  it('blocks first activation after deletion starts before any archive activation exists', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);

    await world.t.mutation(internal.admin.admin.beginOrgDeletion, {
      orgId: world.owner.orgId,
    });
    expect(await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId))).toMatchObject({
      deletionStartedAt: expect.any(Number),
    });
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect()),
    ).resolves.toHaveLength(0);

    await expect(owner.mutation(api.archive.activate, {})).rejects.toThrow('deleting');
  });

  it('lets only an authenticated owner atomically create Archive Activation', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);

    await expect(member.mutation(api.archive.activate, {})).rejects.toThrow('organization owner');
    const first = await owner.mutation(api.archive.activate, {});
    const second = await owner.mutation(api.archive.activate, {});
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.activationId).toBe(first.activationId);
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect()),
    ).resolves.toHaveLength(1);
  });

  it('fails closed for hobby, inactive Pro, or a disabled server gate', async () => {
    const hobby = await seedWorld('hobby');
    enableArchive();
    await expect(asUser(hobby, hobby.owner).mutation(api.archive.activate, {})).rejects.toThrow(
      'Active Pro entitlement',
    );

    const inactive = await seedWorld('pro', 'canceled');
    enableArchive();
    await expect(
      asUser(inactive, inactive.owner).mutation(api.archive.activate, {}),
    ).rejects.toThrow('Active Pro entitlement');

    const gated = await seedWorld();
    disableArchive();
    await expect(asUser(gated, gated.owner).mutation(api.archive.activate, {})).rejects.toThrow(
      'not enabled',
    );
  });

  it('records the 100 GB cap and freezes with a 90-day grace deadline when Pro lapses', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const activation = (
      await world.t.run(async (ctx) => ctx.db.query('archiveActivations').collect())
    )[0]!;
    expect(activation.capBytes).toBe(ARCHIVE_CAP_BYTES);
    expect(activation.graceDeadlineAt).toBeUndefined();

    await world.t.run(async (ctx) => {
      const subscription = (
        await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', world.owner.orgId))
          .collect()
      )[0]!;
      await ctx.db.patch(subscription._id, { status: 'canceled' });
    });
    const before = Date.now();
    await world.t.mutation(internal.archiveInternal.syncLifecycleForOrg, {
      orgId: world.owner.orgId,
    });
    const frozen = await world.t.run(async (ctx) => ctx.db.get(activation._id));
    expect(frozen?.status).toBe('frozen');
    expect(frozen?.graceDeadlineAt).toBeGreaterThanOrEqual(before + ARCHIVE_GRACE_MS);
    expect(frozen?.graceDeadlineAt).toBeLessThanOrEqual(Date.now() + ARCHIVE_GRACE_MS);
  });

  it('enrolls only a Collector Credential bound to the same Organization and User', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);
    await owner.mutation(api.archive.activate, {});

    await expect(owner.mutation(api.archive.enroll, enrollInput(world.memberCred))).rejects.toThrow(
      'Collector Credential not found',
    );
    await expect(
      member.mutation(api.archive.enroll, enrollInput(world.foreignCred)),
    ).rejects.toThrow('Collector Credential not found');

    const created = await member.mutation(api.archive.enroll, enrollInput(world.memberCred));
    expect(created.created).toBe(true);

    const replay = await member.mutation(api.archive.enroll, enrollInput(world.memberCred));
    expect(replay.created).toBe(false);
    expect(replay.enrollmentId).toBe(created.enrollmentId);
    const enrollment = await world.t.run(async (ctx) => ctx.db.get(created.enrollmentId));
    expect(enrollment?.consentSources).toEqual([{ source: 'claude', historyChoice: 'new_only' }]);
    expect(enrollment?.authorizedSources).toEqual([
      expect.objectContaining({ source: 'claude', historyChoice: 'new_only' }),
    ]);
    expect(enrollment?.idempotencyKey).toBe(`consent:${world.memberCred}`);
  });

  it('replays repeated first-use enrollment idempotently without creating a second record', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});

    const first = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    const replay = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    expect(first.created).toBe(true);
    expect(replay).toEqual({
      enrollmentId: first.enrollmentId,
      contributionId: first.contributionId,
      created: false,
    });
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect()),
    ).resolves.toHaveLength(1);
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveEnrollmentSlots').collect()),
    ).resolves.toHaveLength(1);
  });

  it('fails closed when the real-backend archive seed gate is disabled', async () => {
    const world = await seedWorld();
    await expect(
      world.t.mutation(internal.archiveIntegrationSeed.seedConcurrentEnrollment, {}),
    ).rejects.toThrow('disabled outside an explicit test deployment gate');
    await expect(
      world.t.mutation(internal.archiveIntegrationSeed.cleanupConcurrentEnrollment, {
        orgId: world.owner.orgId,
      }),
    ).rejects.toThrow('disabled outside an explicit test deployment gate');
  });

  it('refuses integration cleanup for organizations that were not seeded', async () => {
    process.env.TRACE_FLOW_ARCHIVE_INTEGRATION_TEST_ENABLED = 'true';
    try {
      const world = await seedWorld();
      await expect(
        world.t.mutation(internal.archiveIntegrationSeed.cleanupConcurrentEnrollment, {
          orgId: world.owner.orgId,
        }),
      ).rejects.toThrow('seeded test organizations only');
      expect(await world.t.run(async (ctx) => ctx.db.get(world.owner.orgId))).not.toBeNull();
    } finally {
      delete process.env.TRACE_FLOW_ARCHIVE_INTEGRATION_TEST_ENABLED;
    }
  });

  it('does not treat convex-test Promise.all as OCC concurrent first enrollment', async () => {
    enableArchive();
    const world = await seedWorld();
    let inFlight = 0;
    let maxInFlight = 0;
    const holdTopLevelMutation = async () => {
      await world.t.run(async (ctx) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await ctx.db.query('users').first();
        inFlight -= 1;
      });
    };

    await Promise.all([holdTopLevelMutation(), holdTopLevelMutation()]);
    expect(maxInFlight).toBe(1);
  });

  it('lets a current member self-enroll after activation without archive-wide read authority', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await member.mutation(api.archive.enroll, enrollInput(world.memberCred));

    const ownerStatus = await owner.query(api.archive.getStatus, {});
    const memberStatus = await member.query(api.archive.getStatus, {});

    expect(ownerStatus.contributions).toHaveLength(2);
    expect(ownerStatus.storedBytes).toBe(0);
    expect(ownerStatus.enrolledCollectorCount).toBe(2);
    expect(memberStatus.contributions).toHaveLength(1);
    expect(memberStatus.contributions[0]?.userId).toBe(world.member._id);
    expect(memberStatus.storedBytes).toBeNull();
    expect(memberStatus.enrolledCollectorCount).toBe(1);

    await expect(member.mutation(api.archive.activate, {})).rejects.toThrow('organization owner');
    await expect(
      member.mutation(api.archive.revokeEnrollment, {
        enrollmentId: ownerStatus.contributions[0]!.collectors[0]!.enrollmentId,
      }),
    ).rejects.toThrow('organization owner');
  });

  it('keeps a newly supported Source unauthorized until it is explicitly added', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    const denied = await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
      collectorCredentialId: world.ownerCred,
      source: 'codex',
    });
    expect(denied).toEqual({ allowed: false, reason: 'source_unauthorized' });

    await owner.mutation(api.archive.addAuthorizedSource, {
      enrollmentId: enrolled.enrollmentId,
      source: 'codex',
      historyChoice: 'all_history',
    });
    const allowed = await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
      collectorCredentialId: world.ownerCred,
      source: 'codex',
    });
    expect(allowed).toMatchObject({ allowed: true });
  });

  it('requires a Source for content authorization and never grants a source-neutral write', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await expect(
      world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
      } as never),
    ).rejects.toThrow(/source/i);

    const denied = await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
      collectorCredentialId: world.ownerCred,
      source: 'codex',
    });
    expect(denied).toEqual({ allowed: false, reason: 'source_unauthorized' });
  });

  it('rejects stale membership and cross-tenant IDs', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);
    await owner.mutation(api.archive.activate, {});
    await world.t.run(async (ctx) => {
      await ctx.db.patch(world.memberMembership, { status: 'removed' });
    });

    await expect(
      member.mutation(api.archive.enroll, enrollInput(world.memberCred)),
    ).rejects.toThrow('Not an active organization member');

    const foreign = asUser(world, world.otherOwner);
    await expect(foreign.query(api.archive.getStatus, {})).resolves.toMatchObject({
      lifecycle: 'not_enabled',
    });
    await foreign.mutation(api.archive.activate, {});
    await expect(
      foreign.mutation(api.archive.enroll, enrollInput(world.ownerCred)),
    ).rejects.toThrow('Collector Credential not found');
  });

  it('invalidates enrollment on unenroll, owner revocation, and member removal without deleting the contribution', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);
    await owner.mutation(api.archive.activate, {});
    const ownerEnroll = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    const memberEnroll = await member.mutation(api.archive.enroll, enrollInput(world.memberCred));

    await owner.mutation(api.archive.unenroll, { enrollmentId: ownerEnroll.enrollmentId });
    expect((await world.t.run(async (ctx) => ctx.db.get(ownerEnroll.enrollmentId)))?.status).toBe(
      'unenrolled',
    );
    expect((await world.t.run(async (ctx) => ctx.db.get(ownerEnroll.contributionId)))?.status).toBe(
      'unenrolled',
    );
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'enrollment_invalid' });

    await owner.mutation(api.archive.revokeEnrollment, { enrollmentId: memberEnroll.enrollmentId });
    expect((await world.t.run(async (ctx) => ctx.db.get(memberEnroll.enrollmentId)))?.status).toBe(
      'revoked',
    );
    expect(await world.t.run(async (ctx) => ctx.db.get(memberEnroll.contributionId))).toMatchObject(
      {
        orgId: world.member.orgId,
        userId: world.member._id,
      },
    );

    const member2Cred = await world.t.run(async (ctx) =>
      ctx.db.insert('collectorCredentials', {
        hashedSecret: 'hash-member-2',
        orgId: world.member.orgId,
        userId: world.member._id,
        collectorId: 'collector-member-2',
        status: 'active',
        expiresAt: Date.now() + 60_000,
      }),
    );
    await world.t.run(async (ctx) => {
      await ctx.db.patch(world.memberMembership, { status: 'active' });
    });
    await member.mutation(api.archive.enroll, enrollInput(member2Cred));
    await owner.mutation(api.auth.users.removeMember, { memberId: world.memberMembership });
    const remaining = (
      await world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect())
    ).filter((row) => row.userId === world.member._id && row.status === 'active');
    expect(remaining).toHaveLength(0);
    expect(
      (await world.t.run(async (ctx) => ctx.db.query('archiveContributions').collect())).some(
        (row) => row.userId === world.member._id,
      ),
    ).toBe(true);
  });

  it('creates a new consent record on re-enrollment instead of reviving the revoked one', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const first = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await owner.mutation(api.archive.unenroll, { enrollmentId: first.enrollmentId });
    const second = await owner.mutation(
      api.archive.enroll,
      enrollInput(world.ownerCred, {
        authorizedSources: otherSources,
        idempotencyKey: `consent:${world.ownerCred}:renew`,
      }),
    );
    expect(second.enrollmentId).not.toBe(first.enrollmentId);
    expect(second.created).toBe(true);
    expect((await world.t.run(async (ctx) => ctx.db.get(first.enrollmentId)))?.status).toBe(
      'unenrolled',
    );
    expect(await world.t.run(async (ctx) => ctx.db.get(second.enrollmentId))).toMatchObject({
      status: 'active',
      idempotencyKey: `consent:${world.ownerCred}:renew`,
      authorizedSources: [
        expect.objectContaining({ source: 'codex', historyChoice: 'all_history' }),
      ],
    });
  });

  it('replays a delayed old consent after unenroll or revoke without reactivating it', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);
    await owner.mutation(api.archive.activate, {});

    const ownerFirst = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await owner.mutation(api.archive.unenroll, { enrollmentId: ownerFirst.enrollmentId });
    const delayedUnenrollReplay = await owner.mutation(
      api.archive.enroll,
      enrollInput(world.ownerCred),
    );
    expect(delayedUnenrollReplay).toEqual({
      enrollmentId: ownerFirst.enrollmentId,
      contributionId: ownerFirst.contributionId,
      created: false,
    });
    expect((await world.t.run(async (ctx) => ctx.db.get(ownerFirst.enrollmentId)))?.status).toBe(
      'unenrolled',
    );
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'enrollment_invalid' });

    const memberFirst = await member.mutation(api.archive.enroll, enrollInput(world.memberCred));
    await owner.mutation(api.archive.revokeEnrollment, { enrollmentId: memberFirst.enrollmentId });
    const delayedRevokeReplay = await member.mutation(
      api.archive.enroll,
      enrollInput(world.memberCred),
    );
    expect(delayedRevokeReplay).toEqual({
      enrollmentId: memberFirst.enrollmentId,
      contributionId: memberFirst.contributionId,
      created: false,
    });
    expect((await world.t.run(async (ctx) => ctx.db.get(memberFirst.enrollmentId)))?.status).toBe(
      'revoked',
    );
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.memberCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'enrollment_invalid' });
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect()),
    ).resolves.toHaveLength(2);
  });

  it('allows user unenrollment while the archive gate is disabled', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    disableArchive();
    await owner.mutation(api.archive.unenroll, { enrollmentId: enrolled.enrollmentId });
    expect((await world.t.run(async (ctx) => ctx.db.get(enrolled.enrollmentId)))?.status).toBe(
      'unenrolled',
    );

    enableArchive();
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'enrollment_invalid' });
  });

  it('allows owner revocation while the archive gate is disabled', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);
    await owner.mutation(api.archive.activate, {});
    const enrolled = await member.mutation(api.archive.enroll, enrollInput(world.memberCred));

    disableArchive();
    await owner.mutation(api.archive.revokeEnrollment, { enrollmentId: enrolled.enrollmentId });
    expect((await world.t.run(async (ctx) => ctx.db.get(enrolled.enrollmentId)))?.status).toBe(
      'revoked',
    );

    enableArchive();
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.memberCred,
        source: 'claude',
      }),
    ).toEqual({ allowed: false, reason: 'enrollment_invalid' });
  });

  it('fails when the same idempotency key is reused with a different consent payload', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const first = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    await expect(
      owner.mutation(
        api.archive.enroll,
        enrollInput(world.ownerCred, { authorizedSources: otherSources }),
      ),
    ).rejects.toThrow('does not match the original consent');
    expect(await world.t.run(async (ctx) => ctx.db.get(first.enrollmentId))).toMatchObject({
      status: 'active',
      authorizedSources: [expect.objectContaining({ source: 'claude', historyChoice: 'new_only' })],
    });

    await owner.mutation(api.archive.unenroll, { enrollmentId: first.enrollmentId });
    await expect(
      owner.mutation(
        api.archive.enroll,
        enrollInput(world.ownerCred, { authorizedSources: otherSources }),
      ),
    ).rejects.toThrow('does not match the original consent');
    expect((await world.t.run(async (ctx) => ctx.db.get(first.enrollmentId)))?.status).toBe(
      'unenrolled',
    );
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect()),
    ).resolves.toHaveLength(1);
  });

  it('rejects a new consent key while the Collector is still enrolled', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    await expect(
      owner.mutation(
        api.archive.enroll,
        enrollInput(world.ownerCred, { idempotencyKey: `consent:${world.ownerCred}:other` }),
      ),
    ).rejects.toThrow('already enrolled');
  });

  it('replays the original consent key after a later Source is added', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    await owner.mutation(api.archive.activate, {});
    const first = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));

    const updated = await owner.mutation(api.archive.addAuthorizedSource, {
      enrollmentId: first.enrollmentId,
      source: 'codex',
      historyChoice: 'all_history',
    });
    expect(updated.consentSources).toEqual([{ source: 'claude', historyChoice: 'new_only' }]);
    expect(updated.authorizedSources).toEqual([
      expect.objectContaining({ source: 'claude', historyChoice: 'new_only' }),
      expect.objectContaining({ source: 'codex', historyChoice: 'all_history' }),
    ]);

    const replay = await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
    expect(replay).toEqual({
      enrollmentId: first.enrollmentId,
      contributionId: first.contributionId,
      created: false,
    });
    expect(await world.t.run(async (ctx) => ctx.db.get(first.enrollmentId))).toMatchObject({
      status: 'active',
      consentSources: [{ source: 'claude', historyChoice: 'new_only' }],
    });
    await expect(
      owner.mutation(
        api.archive.enroll,
        enrollInput(world.ownerCred, { authorizedSources: otherSources }),
      ),
    ).rejects.toThrow('does not match the original consent');
    await expect(
      owner.mutation(
        api.archive.enroll,
        enrollInput(world.ownerCred, { idempotencyKey: `consent:${world.ownerCred}:other` }),
      ),
    ).rejects.toThrow('already enrolled');
    expect(
      await world.t.query(internal.archiveInternal.authorizeArchiveWrite, {
        collectorCredentialId: world.ownerCred,
        source: 'codex',
      }),
    ).toMatchObject({ allowed: true, enrollmentId: first.enrollmentId });
  });
});
