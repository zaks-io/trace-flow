import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_CAP_BYTES,
  ARCHIVE_ENABLED_ENV,
  ARCHIVE_GRACE_MS,
  ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS,
  assertArchiveAuthorityReductionAllowed,
  assertHeartbeatObservedAt,
  assertArchiveMutationAllowed,
  consentSourcesMatch,
  isOrganizationDeleted,
  decideEnrollmentAction,
  decideVersionedUpdate,
  decideWriteAuthorization,
  isActiveProSubscription,
  isCollectorCredentialExpired,
  isArchiveServerEnabled,
  isOrganizationDeletionStarted,
  nextActivationStatusForEntitlement,
  pickOldestDocument,
  projectLifecycle,
  resolveServerLifecycle,
  validateAuthorizedSources,
  validateEnrollmentIdempotencyKey,
} from '../archiveLib';
import { otherSources, sources } from './archiveControlPlaneTest.setup';

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

  it('treats a Collector Credential as expired at or after expiresAt', () => {
    expect(isCollectorCredentialExpired({ expiresAt: 10 }, 10)).toBe(true);
    expect(isCollectorCredentialExpired({ expiresAt: 10 }, 11)).toBe(true);
    expect(isCollectorCredentialExpired({ expiresAt: 10 }, 9)).toBe(false);
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
