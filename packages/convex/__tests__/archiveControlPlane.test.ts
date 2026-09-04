import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
  ARCHIVE_CAP_BYTES,
  ARCHIVE_ENABLED_ENV,
  ARCHIVE_GRACE_MS,
  ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS,
  assertArchiveAuthorityReductionAllowed,
  assertHeartbeatObservedAt,
  assertArchiveMutationAllowed,
  beginArchiveDeletion,
  consentSourcesMatch,
  isOrganizationDeleted,
  decideEnrollmentAction,
  decideVersionedUpdate,
  decideWriteAuthorization,
  isActiveProSubscription,
  isArchiveServerEnabled,
  isOrganizationDeletionStarted,
  nextActivationStatusForEntitlement,
  pickOldestDocument,
  projectLifecycle,
  resolveServerLifecycle,
  validateAuthorizedSources,
  validateEnrollmentIdempotencyKey,
} from '../archiveLib';
import { initConvexTest, type ArchiveTestConvex } from './convexTest.setup';

interface SeededWorld {
  t: ArchiveTestConvex;
  owner: { _id: Id<'users'>; tokenIdentifier: string; orgId: Id<'organizations'> };
  member: { _id: Id<'users'>; tokenIdentifier: string; orgId: Id<'organizations'> };
  otherOwner: { _id: Id<'users'>; tokenIdentifier: string; orgId: Id<'organizations'> };
  ownerCred: Id<'collectorCredentials'>;
  memberCred: Id<'collectorCredentials'>;
  foreignCred: Id<'collectorCredentials'>;
  ownerMembership: Id<'organizationMembers'>;
  memberMembership: Id<'organizationMembers'>;
}

function enableArchive() {
  process.env[ARCHIVE_ENABLED_ENV] = 'true';
}

function disableArchive() {
  delete process.env[ARCHIVE_ENABLED_ENV];
}

afterEach(() => {
  disableArchive();
  delete process.env.TRACE_FLOW_ARCHIVE_INTEGRATION_TEST_ENABLED;
});

async function seedWorld(
  tier: 'hobby' | 'pro' = 'pro',
  status: 'active' | 'grace' | 'canceled' = 'active',
): Promise<SeededWorld> {
  const t = initConvexTest();
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://auth.example/|auth0|owner',
      email: 'owner@example.com',
      enabled: true,
    });
    const memberId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://auth.example/|auth0|member',
      email: 'member@example.com',
      enabled: true,
    });
    const otherOwnerId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://auth.example/|auth0|other',
      email: 'other@example.com',
      enabled: true,
    });

    const orgId = await ctx.db.insert('organizations', { name: 'Acme', ownerId });
    const otherOrgId = await ctx.db.insert('organizations', {
      name: 'Other',
      ownerId: otherOwnerId,
    });
    await ctx.db.patch(ownerId, { orgId });
    await ctx.db.patch(memberId, { orgId });
    await ctx.db.patch(otherOwnerId, { orgId: otherOrgId });

    const ownerMembership = await ctx.db.insert('organizationMembers', {
      orgId,
      userId: ownerId,
      role: 'owner',
      status: 'active',
    });
    const memberMembership = await ctx.db.insert('organizationMembers', {
      orgId,
      userId: memberId,
      role: 'member',
      status: 'active',
    });
    await ctx.db.insert('organizationMembers', {
      orgId: otherOrgId,
      userId: otherOwnerId,
      role: 'owner',
      status: 'active',
    });

    await ctx.db.insert('subscriptions', {
      orgId,
      tier,
      status,
      monthlyUnits: 1000,
      addonUnits: 0,
      currentPeriodStart: 1,
      currentPeriodEnd: 2,
      currentPeriodOverageSpentCents: 0,
      addonPurchaseCount: 0,
    });
    await ctx.db.insert('subscriptions', {
      orgId: otherOrgId,
      tier: 'pro',
      status: 'active',
      monthlyUnits: 1000,
      addonUnits: 0,
      currentPeriodStart: 1,
      currentPeriodEnd: 2,
      currentPeriodOverageSpentCents: 0,
      addonPurchaseCount: 0,
    });

    const ownerCred = await ctx.db.insert('collectorCredentials', {
      hashedSecret: 'hash-owner',
      orgId,
      userId: ownerId,
      collectorId: 'collector-owner',
      status: 'active',
      expiresAt: Date.now() + 60_000,
    });
    const memberCred = await ctx.db.insert('collectorCredentials', {
      hashedSecret: 'hash-member',
      orgId,
      userId: memberId,
      collectorId: 'collector-member',
      status: 'active',
      expiresAt: Date.now() + 60_000,
    });
    const foreignCred = await ctx.db.insert('collectorCredentials', {
      hashedSecret: 'hash-foreign',
      orgId: otherOrgId,
      userId: otherOwnerId,
      collectorId: 'collector-foreign',
      status: 'active',
      expiresAt: Date.now() + 60_000,
    });

    return {
      ownerId,
      memberId,
      otherOwnerId,
      orgId,
      otherOrgId,
      ownerCred,
      memberCred,
      foreignCred,
      ownerMembership,
      memberMembership,
    };
  });

  return {
    t,
    owner: {
      _id: ids.ownerId,
      tokenIdentifier: 'https://auth.example/|auth0|owner',
      orgId: ids.orgId,
    },
    member: {
      _id: ids.memberId,
      tokenIdentifier: 'https://auth.example/|auth0|member',
      orgId: ids.orgId,
    },
    otherOwner: {
      _id: ids.otherOwnerId,
      tokenIdentifier: 'https://auth.example/|auth0|other',
      orgId: ids.otherOrgId,
    },
    ownerCred: ids.ownerCred,
    memberCred: ids.memberCred,
    foreignCred: ids.foreignCred,
    ownerMembership: ids.ownerMembership,
    memberMembership: ids.memberMembership,
  };
}

function asUser(world: SeededWorld, user: { tokenIdentifier: string }) {
  return world.t.withIdentity({ tokenIdentifier: user.tokenIdentifier });
}

const sources = [{ source: 'claude' as const, historyChoice: 'new_only' as const }];
const otherSources = [{ source: 'codex' as const, historyChoice: 'all_history' as const }];

function enrollInput(
  collectorCredentialId: Id<'collectorCredentials'>,
  overrides: {
    authorizedSources?: {
      source: 'claude' | 'codex';
      historyChoice: 'new_only' | 'all_history';
    }[];
    idempotencyKey?: string;
  } = {},
) {
  return {
    collectorCredentialId,
    authorizedSources: overrides.authorizedSources ?? sources,
    idempotencyKey: overrides.idempotencyKey ?? `consent:${collectorCredentialId}`,
  };
}

describe('archive control-plane pure functions', () => {
  it('fails closed unless CONVERSATION_ARCHIVE_ENABLED is exactly true', () => {
    expect(isArchiveServerEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isArchiveServerEnabled({ [ARCHIVE_ENABLED_ENV]: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isArchiveServerEnabled({ [ARCHIVE_ENABLED_ENV]: 'true' } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });

  it('treats only active Pro as entitled', () => {
    expect(isActiveProSubscription({ tier: 'pro', status: 'active' })).toBe(true);
    expect(isActiveProSubscription({ tier: 'hobby', status: 'active' })).toBe(false);
    expect(isActiveProSubscription({ tier: 'pro', status: 'grace' })).toBe(false);
    expect(isActiveProSubscription(null)).toBe(false);
  });

  it('replays the same consent attempt and renews only with a new key', () => {
    const request = {
      userId: 'user',
      collectorCredentialId: 'cred',
      authorizedSources: sources,
    };
    const existingByKey = {
      userId: 'user',
      collectorCredentialId: 'cred',
      consentSources: sources,
    };

    expect(decideEnrollmentAction({ existingByKey: null, currentEnrollment: null, request })).toBe(
      'create',
    );
    expect(
      decideEnrollmentAction({
        existingByKey,
        currentEnrollment: { status: 'active' },
        request,
      }),
    ).toBe('replay');
    expect(
      decideEnrollmentAction({
        existingByKey,
        currentEnrollment: { status: 'revoked' },
        request,
      }),
    ).toBe('replay');
    expect(
      decideEnrollmentAction({
        existingByKey,
        currentEnrollment: { status: 'unenrolled' },
        request,
      }),
    ).toBe('replay');
    expect(
      decideEnrollmentAction({
        existingByKey: null,
        currentEnrollment: { status: 'revoked' },
        request,
      }),
    ).toBe('renew');
    expect(
      decideEnrollmentAction({
        existingByKey: null,
        currentEnrollment: { status: 'active' },
        request,
      }),
    ).toBe('already_enrolled');
    expect(
      decideEnrollmentAction({
        existingByKey: { ...existingByKey, consentSources: otherSources },
        currentEnrollment: { status: 'active' },
        request,
      }),
    ).toBe('conflict');
    expect(
      decideEnrollmentAction({
        existingByKey: { ...existingByKey, collectorCredentialId: 'other' },
        currentEnrollment: null,
        request,
      }),
    ).toBe('conflict');
    expect(consentSourcesMatch(sources, sources)).toBe(true);
    expect(consentSourcesMatch(sources, otherSources)).toBe(false);
    expect(validateEnrollmentIdempotencyKey('consent-1')).toBe('consent-1');
    expect(() => validateEnrollmentIdempotencyKey('')).toThrow('required');
    expect(() => validateEnrollmentIdempotencyKey(' consent-1')).toThrow('whitespace');
  });

  it('rejects empty, duplicate, or unsupported Source authorizations', () => {
    expect(() => validateAuthorizedSources([])).toThrow('At least one authorized Source');
    expect(() =>
      validateAuthorizedSources([
        { source: 'claude', historyChoice: 'new_only' },
        { source: 'claude', historyChoice: 'all_history' },
      ]),
    ).toThrow('listed more than once');
    expect(() =>
      validateAuthorizedSources([{ source: 'cursor' as never, historyChoice: 'new_only' }]),
    ).toThrow('not authorized');
  });

  it('keeps the first-writer document when concurrent inserts collide', () => {
    const older = { _id: 'a', _creationTime: 1 };
    const newer = { _id: 'b', _creationTime: 2 };
    expect(pickOldestDocument([newer, older])).toEqual(older);
    expect(pickOldestDocument([])).toBeNull();
  });

  it('keeps deleting terminal when entitlement later changes', () => {
    expect(nextActivationStatusForEntitlement('deleting', true)).toBe('deleting');
    expect(nextActivationStatusForEntitlement('deleting', false)).toBe('deleting');
    expect(nextActivationStatusForEntitlement('frozen', true)).toBe('active');
    expect(nextActivationStatusForEntitlement('active', false)).toBe('frozen');
  });

  it('projects blocked at the recorded 100 GB cap', () => {
    expect(
      projectLifecycle({
        activation: { status: 'active' },
        storedBytes: ARCHIVE_CAP_BYTES,
        capBytes: ARCHIVE_CAP_BYTES,
      }),
    ).toBe('blocked');
    expect(ARCHIVE_CAP_BYTES).toBe(100 * 1024 * 1024 * 1024);
    expect(ARCHIVE_GRACE_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(resolveServerLifecycle('frozen', 'active')).toBe('frozen');
    expect(resolveServerLifecycle('frozen', 'deleting')).toBe('deleting');
    expect(resolveServerLifecycle('deleting', 'active')).toBe('deleting');
    expect(resolveServerLifecycle('active', 'blocked')).toBe('blocked');
  });

  it('treats a missing organization as deleted for archive writes', () => {
    expect(isOrganizationDeleted(null)).toBe(true);
    expect(isOrganizationDeleted(undefined)).toBe(true);
    expect(isOrganizationDeletionStarted({ deletionStartedAt: 1 })).toBe(true);
    expect(isOrganizationDeletionStarted({})).toBe(false);
    expect(isOrganizationDeleted({ deletedAt: 1 })).toBe(true);
    expect(isOrganizationDeleted({})).toBe(false);
    expect(() =>
      assertArchiveMutationAllowed({
        org: null,
        activation: { status: 'active' },
        serverEnabled: true,
      }),
    ).toThrow('Organization not found');
    expect(() =>
      assertArchiveMutationAllowed({
        org: { deletedAt: 1 },
        activation: { status: 'active' },
        serverEnabled: true,
      }),
    ).toThrow('Organization not found');
    expect(() =>
      assertArchiveMutationAllowed({
        org: {},
        activation: { status: 'deleting' },
        serverEnabled: true,
      }),
    ).toThrow('deleting');
    expect(() =>
      assertArchiveMutationAllowed({
        org: { deletionStartedAt: 1 },
        activation: { status: 'active' },
        serverEnabled: true,
      }),
    ).toThrow('deleting');
    expect(() =>
      assertArchiveMutationAllowed({
        org: {},
        activation: { status: 'active' },
        serverEnabled: false,
      }),
    ).toThrow('not enabled');
    expect(() =>
      assertArchiveMutationAllowed({
        org: {},
        activation: { status: 'active' },
        serverEnabled: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertArchiveAuthorityReductionAllowed({
        org: {},
        activation: { status: 'active' },
      }),
    ).not.toThrow();
    expect(() =>
      assertArchiveAuthorityReductionAllowed({
        org: null,
        activation: { status: 'active' },
      }),
    ).toThrow('Organization not found');
    expect(() =>
      assertArchiveAuthorityReductionAllowed({
        org: { deletionStartedAt: 1 },
        activation: { status: 'active' },
      }),
    ).toThrow('deleting');
  });

  it('denies writes when the server gate, entitlement, or enrollment is closed', () => {
    const base = {
      serverEnabled: true,
      activation: { status: 'active' as const },
      subscription: { tier: 'pro', status: 'active' },
      credential: { status: 'active', orgId: 'org', userId: 'user' },
      enrollment: { status: 'active' as const, authorizedSources: [{ source: 'claude' }] },
      source: 'claude',
    };
    expect(decideWriteAuthorization(base)).toEqual({ allowed: true });
    expect(decideWriteAuthorization({ ...base, serverEnabled: false })).toEqual({
      allowed: false,
      reason: 'server_disabled',
    });
    expect(
      decideWriteAuthorization({ ...base, subscription: { tier: 'hobby', status: 'active' } }),
    ).toEqual({
      allowed: false,
      reason: 'not_pro',
    });
    expect(
      decideWriteAuthorization({
        ...base,
        enrollment: { status: 'revoked', authorizedSources: [] },
      }),
    ).toEqual({
      allowed: false,
      reason: 'enrollment_invalid',
    });
    expect(decideWriteAuthorization({ ...base, source: 'codex' })).toEqual({
      allowed: false,
      reason: 'source_unauthorized',
    });
  });

  it('treats exact versioned replays as no-ops and rejects stale or conflicting updates', () => {
    expect(
      decideVersionedUpdate({ storedVersion: undefined, incomingVersion: 1, payloadEquals: false }),
    ).toBe('apply');
    expect(
      decideVersionedUpdate({ storedVersion: 2, incomingVersion: 3, payloadEquals: false }),
    ).toBe('apply');
    expect(
      decideVersionedUpdate({ storedVersion: 2, incomingVersion: 2, payloadEquals: true }),
    ).toBe('replay');
    expect(
      decideVersionedUpdate({ storedVersion: 2, incomingVersion: 2, payloadEquals: false }),
    ).toBe('conflict');
    expect(
      decideVersionedUpdate({ storedVersion: 2, incomingVersion: 1, payloadEquals: true }),
    ).toBe('stale');
  });

  it('rejects heartbeat observations beyond the allowed future skew', () => {
    const now = 10_000;
    expect(() =>
      assertHeartbeatObservedAt(now + ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS, now),
    ).not.toThrow();
    expect(() =>
      assertHeartbeatObservedAt(now + ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS + 1, now),
    ).toThrow('in the future');
    expect(() => assertHeartbeatObservedAt(Number.NaN, now)).toThrow('invalid');
  });
});

describe('archive control plane', () => {
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
      },
    );
    expect(denied).toEqual({ allowed: false, reason: 'enrollment_invalid' });
  });
});
