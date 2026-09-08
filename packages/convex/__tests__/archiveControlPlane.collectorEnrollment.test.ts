import { describe, expect, it } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { api } from '../_generated/api';
import { asUser, disableArchive, enableArchive, seedWorld } from './archiveControlPlaneTest.setup';

const enrollCollector = makeFunctionReference<'mutation'>(
  'archiveInternal:enrollCollectorByHashedSecret',
);

function request(
  overrides: Partial<{
    hashedSecret: string;
    source: 'claude' | 'codex';
    historyChoice: 'new_only' | 'all_history';
    idempotencyKey: string;
    orgId: string;
    userId: string;
    collectorId: string;
    now: number;
  }> = {},
) {
  return {
    hashedSecret: overrides.hashedSecret ?? 'hash-owner',
    authorizedSources: [
      {
        source: overrides.source ?? ('claude' as const),
        historyChoice: overrides.historyChoice ?? ('all_history' as const),
      },
    ],
    idempotencyKey: overrides.idempotencyKey ?? 'archive-enroll:test-owner',
    orgId: overrides.orgId ?? '',
    userId: overrides.userId ?? '',
    collectorId: overrides.collectorId ?? 'collector-owner',
    now: overrides.now ?? Date.now(),
  };
}

describe('collector-authenticated archive enrollment', () => {
  it('serializes concurrent duplicate requests into one enrollment', async () => {
    enableArchive();
    const world = await seedWorld();
    const args = request({ orgId: world.owner.orgId, userId: world.owner._id, now: 1000 });

    const [first, second] = await Promise.all([
      world.t.mutation(enrollCollector, args),
      world.t.mutation(enrollCollector, args),
    ]);

    expect(second).toEqual(first);
    const rows = await world.t.run(async (ctx) => ({
      activations: await ctx.db.query('archiveActivations').collect(),
      enrollments: await ctx.db.query('archiveEnrollments').collect(),
      slots: await ctx.db.query('archiveEnrollmentSlots').collect(),
      contributions: await ctx.db.query('archiveContributions').collect(),
    }));
    expect(rows.activations).toHaveLength(1);
    expect(rows.enrollments).toHaveLength(1);
    expect(rows.slots).toHaveLength(1);
    expect(rows.contributions).toHaveLength(1);
  });

  it('atomically activates for the owner and replays without changing consent timestamps', async () => {
    enableArchive();
    const world = await seedWorld();
    const args = request({ orgId: world.owner.orgId, userId: world.owner._id, now: 1000 });

    const first = await world.t.mutation(enrollCollector, args);
    const replay = await world.t.mutation(enrollCollector, { ...args, now: 2000 });

    expect(first).toMatchObject({
      enrolled: true,
      orgId: world.owner.orgId,
      userId: world.owner._id,
      collectorId: 'collector-owner',
      authorizedSources: [{ source: 'claude', historyChoice: 'all_history', authorizedAt: 1000 }],
    });
    expect(replay).toEqual(first);
    const rows = await world.t.run(async (ctx) => ({
      activations: await ctx.db.query('archiveActivations').collect(),
      enrollments: await ctx.db.query('archiveEnrollments').collect(),
      audits: await ctx.db.query('archiveAuditEvents').collect(),
    }));
    expect(rows.activations).toHaveLength(1);
    expect(rows.enrollments).toHaveLength(1);
    expect(rows.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'activation',
          actorKind: 'user',
          actorUserId: world.owner._id,
        }),
      ]),
    );
  });

  it('adds a Source without changing the existing Source and rejects a history conflict', async () => {
    enableArchive();
    const world = await seedWorld();
    const base = request({ orgId: world.owner.orgId, userId: world.owner._id, now: 1000 });
    await world.t.mutation(enrollCollector, base);

    const added = await world.t.mutation(
      enrollCollector,
      request({
        orgId: world.owner.orgId,
        userId: world.owner._id,
        source: 'codex',
        historyChoice: 'new_only',
        idempotencyKey: 'archive-enroll:test-codex',
        now: 2000,
      }),
    );
    expect(added.authorizedSources).toEqual([
      { source: 'claude', historyChoice: 'all_history', authorizedAt: 1000 },
      { source: 'codex', historyChoice: 'new_only', authorizedAt: 2000 },
    ]);

    await expect(
      world.t.mutation(
        enrollCollector,
        request({
          orgId: world.owner.orgId,
          userId: world.owner._id,
          historyChoice: 'new_only',
          idempotencyKey: 'archive-enroll:test-conflict',
          now: 3000,
        }),
      ),
    ).rejects.toThrow('consent_conflict');
    const enrollment = (await world.t.run(async (ctx) =>
      ctx.db.query('archiveEnrollments').first(),
    ))!;
    expect(enrollment.authorizedSources).toEqual(added.authorizedSources);
  });

  it('denies non-owner activation and allows that member after the owner activates', async () => {
    enableArchive();
    const world = await seedWorld();
    const memberRequest = request({
      hashedSecret: 'hash-member',
      orgId: world.member.orgId,
      userId: world.member._id,
      collectorId: 'collector-member',
      idempotencyKey: 'archive-enroll:test-member',
    });
    await expect(world.t.mutation(enrollCollector, memberRequest)).resolves.toEqual({
      enrolled: false,
      authorizedSources: [],
      reason: 'not_activated',
    });
    await expect(
      world.t.run(async (ctx) => ctx.db.query('archiveEnrollments').collect()),
    ).resolves.toHaveLength(0);

    await asUser(world, world.owner).mutation(api.archive.activate, {});
    await expect(world.t.mutation(enrollCollector, memberRequest)).resolves.toMatchObject({
      enrolled: true,
      userId: world.member._id,
    });
  });

  it('fails closed for foreign identity, expired or revoked credentials, and stale users', async () => {
    enableArchive();
    const world = await seedWorld();
    const ownerRequest = request({ orgId: world.owner.orgId, userId: world.owner._id });
    await expect(
      world.t.mutation(enrollCollector, { ...ownerRequest, hashedSecret: 'hash-unknown' }),
    ).resolves.toMatchObject({ enrolled: false, reason: 'not_enrolled' });
    await expect(
      world.t.mutation(enrollCollector, { ...ownerRequest, userId: world.member._id }),
    ).resolves.toMatchObject({ enrolled: false, reason: 'not_enrolled' });
    await expect(
      world.t.mutation(enrollCollector, { ...ownerRequest, collectorId: 'collector-foreign' }),
    ).resolves.toMatchObject({ enrolled: false, reason: 'not_enrolled' });

    await world.t.run(async (ctx) => ctx.db.patch(world.ownerCred, { expiresAt: 1000 }));
    await expect(
      world.t.mutation(enrollCollector, { ...ownerRequest, now: 1000 }),
    ).resolves.toMatchObject({ enrolled: false, reason: 'credential_revoked' });
    await world.t.run(async (ctx) =>
      ctx.db.patch(world.ownerCred, { expiresAt: Date.now() + 60_000, status: 'revoked' }),
    );
    await expect(world.t.mutation(enrollCollector, ownerRequest)).resolves.toMatchObject({
      enrolled: false,
      reason: 'credential_revoked',
    });

    await world.t.run(async (ctx) => {
      await ctx.db.patch(world.ownerCred, { status: 'active' });
      await ctx.db.patch(world.owner._id, { enabled: false });
    });
    await expect(world.t.mutation(enrollCollector, ownerRequest)).resolves.toMatchObject({
      enrolled: false,
      reason: 'not_enrolled',
    });
    await world.t.run(async (ctx) => {
      await ctx.db.patch(world.owner._id, { enabled: true });
      await ctx.db.patch(world.ownerMembership, { status: 'removed' });
    });
    await expect(world.t.mutation(enrollCollector, ownerRequest)).resolves.toMatchObject({
      enrolled: false,
      reason: 'not_enrolled',
    });
    await expect(
      world.t.run(async (ctx) => ({
        activations: await ctx.db.query('archiveActivations').collect(),
        enrollments: await ctx.db.query('archiveEnrollments').collect(),
      })),
    ).resolves.toEqual({ activations: [], enrollments: [] });
  });

  it('applies server, Pro, frozen, and deletion gates before enrollment', async () => {
    const serverDisabled = await seedWorld();
    const disabledRequest = request({
      orgId: serverDisabled.owner.orgId,
      userId: serverDisabled.owner._id,
    });
    disableArchive();
    await expect(
      serverDisabled.t.mutation(enrollCollector, disabledRequest),
    ).resolves.toMatchObject({
      enrolled: false,
      reason: 'server_disabled',
    });

    enableArchive();
    const hobby = await seedWorld('hobby');
    await expect(
      hobby.t.mutation(
        enrollCollector,
        request({ orgId: hobby.owner.orgId, userId: hobby.owner._id }),
      ),
    ).resolves.toMatchObject({ enrolled: false, reason: 'not_pro' });

    const frozen = await seedWorld();
    await asUser(frozen, frozen.owner).mutation(api.archive.activate, {});
    await frozen.t.run(async (ctx) => {
      const activation = await ctx.db.query('archiveActivations').first();
      await ctx.db.patch(activation!._id, { status: 'frozen' });
    });
    await expect(
      frozen.t.mutation(
        enrollCollector,
        request({ orgId: frozen.owner.orgId, userId: frozen.owner._id }),
      ),
    ).resolves.toMatchObject({ enrolled: false, reason: 'frozen' });

    const deleting = await seedWorld();
    await deleting.t.run(async (ctx) =>
      ctx.db.patch(deleting.owner.orgId, { deletionStartedAt: Date.now() }),
    );
    await expect(
      deleting.t.mutation(
        enrollCollector,
        request({ orgId: deleting.owner.orgId, userId: deleting.owner._id }),
      ),
    ).resolves.toMatchObject({ enrolled: false, reason: 'deleting' });
  });
});
