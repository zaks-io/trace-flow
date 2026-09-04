import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { ARCHIVE_ENABLED_ENV } from '../archiveLib';
import {
  ARCHIVE_API_AUDIT_ACTIONS,
  decideAuditAppend,
  serializeArchiveApiAuditInput,
} from '../archiveAuditLib';
import { initConvexTest, type ArchiveTestConvex } from './convexTest.setup';

interface SeededWorld {
  t: ArchiveTestConvex;
  owner: { _id: Id<'users'>; tokenIdentifier: string; orgId: Id<'organizations'> };
  member: { _id: Id<'users'>; tokenIdentifier: string; orgId: Id<'organizations'> };
  otherOwner: { _id: Id<'users'>; tokenIdentifier: string; orgId: Id<'organizations'> };
  ownerCred: Id<'collectorCredentials'>;
  memberCred: Id<'collectorCredentials'>;
}

function enableArchive() {
  process.env[ARCHIVE_ENABLED_ENV] = 'true';
}

function disableArchive() {
  delete process.env[ARCHIVE_ENABLED_ENV];
}

afterEach(() => {
  disableArchive();
});

async function seedWorld(): Promise<SeededWorld> {
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

    await ctx.db.insert('organizationMembers', {
      orgId,
      userId: ownerId,
      role: 'owner',
      status: 'active',
    });
    await ctx.db.insert('organizationMembers', {
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
      tier: 'pro',
      status: 'active',
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

    return { ownerId, memberId, otherOwnerId, orgId, otherOrgId, ownerCred, memberCred };
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
  };
}

function asUser(world: SeededWorld, user: { tokenIdentifier: string }) {
  return world.t.withIdentity({ tokenIdentifier: user.tokenIdentifier });
}

const sources = [{ source: 'claude' as const, historyChoice: 'new_only' as const }];
const MANIFEST_ROOT = 'a'.repeat(64);

describe('archive audit serializer', () => {
  const valid = {
    binding: { kind: 'enrollment', enrollmentId: 'k57axc8sefsfp6k28nx6c481js806pwv' },
    action: 'export_completed',
    outcome: 'success',
    operationId: 'export:op-1',
  };

  it('rejects transcript fields, commands, paths, secrets, payloads, and unknown types', () => {
    expect(() => serializeArchiveApiAuditInput({ ...valid, transcript: 'hello' })).toThrow(
      'cannot store transcript',
    );
    expect(() => serializeArchiveApiAuditInput({ ...valid, commands: ['ls'] })).toThrow(
      'cannot store commands',
    );
    expect(() => serializeArchiveApiAuditInput({ ...valid, path: '/Users/me/.claude' })).toThrow(
      'cannot store path',
    );
    expect(() => serializeArchiveApiAuditInput({ ...valid, secret: 'tf_live' })).toThrow(
      'cannot store secret',
    );
    expect(() => serializeArchiveApiAuditInput({ ...valid, payload: { text: 'hi' } })).toThrow(
      'cannot store payload',
    );
    expect(() => serializeArchiveApiAuditInput({ ...valid, action: 'chunk_upload' })).toThrow(
      'Per-chunk',
    );
    expect(() => serializeArchiveApiAuditInput({ ...valid, action: 'chunk_download' })).toThrow(
      'Per-chunk',
    );
    expect(() => serializeArchiveApiAuditInput({ ...valid, action: 'not_a_real_event' })).toThrow(
      'Unknown archive audit event type',
    );
    expect(() =>
      serializeArchiveApiAuditInput({ ...valid, manifestRootHash: '/tmp/records.jsonl' }),
    ).toThrow('Manifest root hash');
    expect(() =>
      serializeArchiveApiAuditInput({ ...valid, targetId: '/home/user/session' }),
    ).toThrow('must not contain a path');
  });

  it('rejects caller-supplied actor, tenant, and clock substitution', () => {
    expect(() =>
      serializeArchiveApiAuditInput({ ...valid, actorUserId: 'j57axc8sefsfp6k28nx6c481js806pwv' }),
    ).toThrow('substitution');
    expect(() =>
      serializeArchiveApiAuditInput({ ...valid, orgId: 'k57axc8sefsfp6k28nx6c481js806pwv' }),
    ).toThrow('substitution');
    expect(() => serializeArchiveApiAuditInput({ ...valid, occurredAt: 1 })).toThrow(
      'substitution',
    );
  });

  it('does not treat user lifecycle actions as Archive API event types', () => {
    expect(() => serializeArchiveApiAuditInput({ ...valid, action: 'activation' })).toThrow(
      'Unknown archive audit event type',
    );
    expect(ARCHIVE_API_AUDIT_ACTIONS).not.toContain('activation');
  });

  it('replays success for one operation identity and keeps distinct failures', () => {
    expect(
      decideAuditAppend({
        existingSuccess: { action: 'export_completed' },
        incoming: { action: 'export_completed', outcome: 'success' },
      }),
    ).toBe('replay');
    expect(
      decideAuditAppend({
        existingSuccess: { action: 'export_completed' },
        incoming: { action: 'export_failed', outcome: 'failure' },
      }),
    ).toBe('append');
    expect(
      decideAuditAppend({
        existingSuccess: null,
        incoming: { action: 'export_failed', outcome: 'failure' },
      }),
    ).toBe('append');
  });
});

describe('archive audit control plane', () => {
  it('records actor-bound activation, enrollment, and revocation events', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const member = asUser(world, world.member);

    const activation = await owner.mutation(api.archive.activate, {});
    const enrollment = await member.mutation(api.archive.enroll, {
      collectorCredentialId: world.memberCred,
      authorizedSources: sources,
      idempotencyKey: 'consent-member-1',
    });
    await owner.mutation(api.archive.revokeEnrollment, { enrollmentId: enrollment.enrollmentId });

    const events = await owner.query(api.archiveAudit.listEvents, {});
    expect(events.map((event) => event.action)).toEqual(['activation', 'enrollment', 'revocation']);
    expect(events[0]).toMatchObject({
      orgId: world.owner.orgId,
      actorKind: 'user',
      actorUserId: world.owner._id,
      action: 'activation',
      outcome: 'success',
      activationId: activation.activationId,
    });
    expect(events[1]).toMatchObject({
      orgId: world.member.orgId,
      actorKind: 'user',
      actorUserId: world.member._id,
      action: 'enrollment',
      outcome: 'success',
      enrollmentId: enrollment.enrollmentId,
      contributionId: enrollment.contributionId,
    });
    expect(events[2]).toMatchObject({
      orgId: world.owner.orgId,
      actorKind: 'user',
      actorUserId: world.owner._id,
      action: 'revocation',
      outcome: 'success',
      enrollmentId: enrollment.enrollmentId,
    });
    expect(events.every((event) => !('transcript' in event) && !('payload' in event))).toBe(true);
  });

  it('does not create a second success event when an idempotent user operation is replayed', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);

    await owner.mutation(api.archive.activate, {});
    await owner.mutation(api.archive.activate, {});
    const first = await owner.mutation(api.archive.enroll, {
      collectorCredentialId: world.ownerCred,
      authorizedSources: sources,
      idempotencyKey: 'consent-owner-1',
    });
    await owner.mutation(api.archive.enroll, {
      collectorCredentialId: world.ownerCred,
      authorizedSources: sources,
      idempotencyKey: 'consent-owner-1',
    });
    await owner.mutation(api.archive.unenroll, { enrollmentId: first.enrollmentId });
    await owner.mutation(api.archive.unenroll, { enrollmentId: first.enrollmentId });

    const events = await owner.query(api.archiveAudit.listEvents, {});
    expect(
      events.filter((event) => event.action === 'activation' && event.outcome === 'success'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.action === 'enrollment' && event.outcome === 'success'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.action === 'revocation' && event.outcome === 'success'),
    ).toHaveLength(1);
  });

  it('lets Archive API append only within the server-derived Organization and schema', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const activation = await owner.mutation(api.archive.activate, {});
    const enrollment = await owner.mutation(api.archive.enroll, {
      collectorCredentialId: world.ownerCred,
      authorizedSources: sources,
      idempotencyKey: 'consent-owner-api',
    });

    const first = await world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
      binding: { kind: 'enrollment', enrollmentId: enrollment.enrollmentId },
      expectedOrgId: world.owner.orgId,
      action: 'export_grant_issuance',
      outcome: 'success',
      operationId: 'export-grant:op-1',
      targetKind: 'export',
      targetId: 'export-1',
    });
    const replay = await world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
      binding: { kind: 'enrollment', enrollmentId: enrollment.enrollmentId },
      expectedOrgId: world.owner.orgId,
      action: 'export_grant_issuance',
      outcome: 'success',
      operationId: 'export-grant:op-1',
      targetKind: 'export',
      targetId: 'export-1',
    });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.eventId).toBe(first.eventId);

    await world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
      binding: { kind: 'activation', activationId: activation.activationId },
      action: 'export_failed',
      outcome: 'failure',
      operationId: 'export:op-2',
      targetKind: 'export',
      targetId: 'export-2',
    });
    await world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
      binding: { kind: 'activation', activationId: activation.activationId },
      action: 'export_failed',
      outcome: 'failure',
      operationId: 'export:op-2',
      targetKind: 'export',
      targetId: 'export-2',
    });
    const completed = await world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
      binding: { kind: 'activation', activationId: activation.activationId },
      action: 'export_completed',
      outcome: 'success',
      operationId: 'export:op-2',
      targetKind: 'export',
      targetId: 'export-2',
      relevantCount: 3,
      manifestRootHash: MANIFEST_ROOT,
    });
    const completedReplay = await world.t.mutation(
      internal.archiveAuditInternal.appendSemanticEvent,
      {
        binding: { kind: 'activation', activationId: activation.activationId },
        action: 'export_completed',
        outcome: 'success',
        operationId: 'export:op-2',
        targetKind: 'export',
        targetId: 'export-2',
        relevantCount: 3,
        manifestRootHash: MANIFEST_ROOT,
      },
    );
    expect(completed.created).toBe(true);
    expect(completedReplay.created).toBe(false);

    await world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
      binding: { kind: 'collector_credential', collectorCredentialId: world.ownerCred },
      action: 'integrity_failure',
      outcome: 'failure',
      operationId: 'integrity:session-1:attempt-1',
      targetKind: 'session',
      targetId: 'session-1',
      source: 'claude',
      sourceSessionId: 'session-1',
    });
    await world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
      binding: { kind: 'collector_credential', collectorCredentialId: world.ownerCred },
      action: 'operator_repair_attempt',
      outcome: 'success',
      operationId: 'repair:session-1:attempt-1',
      targetKind: 'session',
      targetId: 'session-1',
      source: 'claude',
      sourceSessionId: 'session-1',
    });
    await world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
      binding: { kind: 'collector_credential', collectorCredentialId: world.ownerCred },
      action: 'operator_repair_outcome',
      outcome: 'success',
      operationId: 'repair:session-1:outcome',
      targetKind: 'session',
      targetId: 'session-1',
      source: 'claude',
      sourceSessionId: 'session-1',
      manifestRootHash: MANIFEST_ROOT,
    });

    const events = await owner.query(api.archiveAudit.listEvents, {});
    expect(events.filter((event) => event.action === 'export_grant_issuance')).toHaveLength(1);
    expect(events.filter((event) => event.action === 'export_failed')).toHaveLength(2);
    expect(events.filter((event) => event.action === 'export_completed')).toHaveLength(1);
    const completedEvent = events.find((event) => event.action === 'export_completed');
    expect(completedEvent).toMatchObject({
      actorKind: 'archive_api',
      relevantCount: 3,
      manifestRootHash: MANIFEST_ROOT,
    });
    expect(completedEvent?.actorUserId).toBeUndefined();
    expect(events.find((event) => event.action === 'operator_repair_attempt')).toMatchObject({
      actorKind: 'operator',
    });
    expect(
      events.some(
        (event) =>
          (event.action as string) === 'chunk_upload' ||
          (event.action as string) === 'chunk_download',
      ),
    ).toBe(false);
  });

  it('fails closed when the caller supplies a substitute actor or tenant', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const enrollment = await owner.mutation(api.archive.activate, {}).then(() =>
      owner.mutation(api.archive.enroll, {
        collectorCredentialId: world.ownerCred,
        authorizedSources: sources,
        idempotencyKey: 'consent-owner-sub',
      }),
    );

    await expect(
      world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
        binding: { kind: 'enrollment', enrollmentId: enrollment.enrollmentId },
        expectedOrgId: world.otherOwner.orgId,
        action: 'deletion',
        outcome: 'success',
        operationId: 'delete:op-1',
      }),
    ).rejects.toThrow('substitution');

    await expect(
      world.t.mutation(internal.archiveAuditInternal.appendSemanticEvent, {
        binding: { kind: 'enrollment', enrollmentId: enrollment.enrollmentId },
        action: 'activation',
        outcome: 'success',
        operationId: 'activation-forged',
      } as never),
    ).rejects.toThrow();
  });

  it('keeps audit queries inside the authenticated Organization', async () => {
    enableArchive();
    const world = await seedWorld();
    const owner = asUser(world, world.owner);
    const foreign = asUser(world, world.otherOwner);

    await owner.mutation(api.archive.activate, {});
    await foreign.mutation(api.archive.activate, {});

    const ownerEvents = await owner.query(api.archiveAudit.listEvents, {});
    const foreignEvents = await foreign.query(api.archiveAudit.listEvents, {});
    expect(ownerEvents).toHaveLength(1);
    expect(foreignEvents).toHaveLength(1);
    expect(ownerEvents[0]?.orgId).toBe(world.owner.orgId);
    expect(foreignEvents[0]?.orgId).toBe(world.otherOwner.orgId);
    expect(ownerEvents[0]?.orgId).not.toBe(foreignEvents[0]?.orgId);

    const scoped = await world.t.query(internal.archiveAuditInternal.listEventsForOrg, {
      orgId: world.owner.orgId,
    });
    expect(scoped.every((event) => event.orgId === world.owner.orgId)).toBe(true);
    expect(scoped.some((event) => event.orgId === world.otherOwner.orgId)).toBe(false);
  });
});
