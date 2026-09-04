import { afterEach, describe, expect, it } from 'vitest';
import {
  activate,
  addAuthorizedSource,
  enroll,
  getStatus,
  reportHeartbeat,
  revokeEnrollment,
  unenroll,
} from '../archive';
import {
  applyServerStatus,
  authorizeArchiveWrite,
  reportCollectorHeartbeat,
  upsertSessionIntegrity,
} from '../archiveInternal';
import { removeMember } from '../auth/users';
import { syncLifecycleForOrg } from '../archiveInternal';
import {
  ARCHIVE_CAP_BYTES,
  ARCHIVE_ENABLED_ENV,
  ARCHIVE_GRACE_MS,
  consentSourcesMatch,
  decideEnrollmentAction,
  decideWriteAuthorization,
  isActiveProSubscription,
  isArchiveServerEnabled,
  nextActivationStatusForEntitlement,
  pickOldestDocument,
  projectLifecycle,
  validateAuthorizedSources,
  validateEnrollmentIdempotencyKey,
} from '../archiveLib';

type TableName = string;
type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

class ConvexTestDriver {
  private tables = new Map<TableName, Map<string, Doc>>();
  private seq = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  snapshot(): Map<TableName, Map<string, Doc>> {
    const copy = new Map<TableName, Map<string, Doc>>();
    for (const [table, rows] of this.tables) {
      copy.set(table, new Map(rows));
    }
    return copy;
  }

  restore(snapshot: Map<TableName, Map<string, Doc>>) {
    this.tables = snapshot;
  }

  private table(name: TableName): Map<string, Doc> {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = new Map();
      this.tables.set(name, rows);
    }
    return rows;
  }

  insert(table: TableName, doc: Record<string, unknown>): string {
    const id = `${table}_${++this.seq}`;
    this.table(table).set(id, { ...doc, _id: id, _creationTime: Date.now() });
    return id;
  }

  get(id: string): Doc | null {
    for (const rows of this.tables.values()) {
      const doc = rows.get(id);
      if (doc) return { ...doc };
    }
    return null;
  }

  patch(id: string, patch: Record<string, unknown>) {
    for (const rows of this.tables.values()) {
      const doc = rows.get(id);
      if (!doc) continue;
      rows.set(id, { ...doc, ...patch });
      return;
    }
    throw new Error(`Missing document ${id}`);
  }

  delete(id: string) {
    for (const rows of this.tables.values()) {
      if (rows.delete(id)) return;
    }
    throw new Error(`Missing document ${id}`);
  }

  query(table: TableName) {
    const rows = () => [...this.table(table).values()];
    let matches = rows();
    const api = {
      withIndex: (_name: string, fn?: (q: IndexBuilder) => void) => {
        if (fn) {
          const builder = new IndexBuilder();
          fn(builder);
          matches = rows().filter((doc) => builder.matches(doc));
        }
        return api;
      },
      filter: (fn: (q: FilterBuilder) => boolean) => {
        matches = matches.filter((doc) => fn(new FilterBuilder(doc)));
        return api;
      },
      first: async () => (matches[0] ? { ...matches[0] } : null),
      unique: async () => {
        if (matches.length > 1) throw new Error(`Unique index returned ${matches.length} rows`);
        return matches[0] ? { ...matches[0] } : null;
      },
      collect: async () => matches.map((doc) => ({ ...doc })),
      take: async (n: number) => matches.slice(0, n).map((doc) => ({ ...doc })),
    };
    return api;
  }

  ctx(identity: { tokenIdentifier: string } | null) {
    return {
      auth: {
        getUserIdentity: async () => identity,
      },
      db: {
        insert: async (table: TableName, doc: Record<string, unknown>) => this.insert(table, doc),
        get: async (id: string) => this.get(id),
        patch: async (id: string, patch: Record<string, unknown>) => this.patch(id, patch),
        delete: async (id: string) => this.delete(id),
        query: (table: TableName) => this.query(table),
      },
      scheduler: {
        runAfter: async () => 'scheduled',
        cancel: async () => undefined,
      },
    };
  }

  async transact<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

class IndexBuilder {
  private eqs: { field: string; value: unknown }[] = [];
  eq(field: string, value: unknown) {
    this.eqs.push({ field, value });
    return this;
  }
  matches(doc: Doc) {
    return this.eqs.every((eq) => doc[eq.field] === eq.value);
  }
}

class FilterBuilder {
  constructor(private readonly doc: Doc) {}
  field(name: string) {
    return this.doc[name];
  }
  eq(left: unknown, right: unknown) {
    return left === right;
  }
}

interface Handler<Args, Result> {
  _handler: (ctx: unknown, args: Args) => Promise<Result>;
}

function call<Result>(fn: unknown, ctx: unknown, args: unknown = {}): Promise<Result> {
  return (fn as Handler<unknown, Result>)._handler(ctx, args);
}

interface ActivateResult {
  activationId: string;
  created: boolean;
}
interface EnrollResult {
  enrollmentId: string;
  contributionId: string;
  created: boolean;
}
type WriteDecision =
  | { allowed: true; enrollmentId: string; contributionId: string }
  | { allowed: false; reason: string };
interface StatusResult {
  lifecycle: string;
  storedBytes: number | null;
  lastDurableAcknowledgedAt: number | null;
  enrolledCollectorCount: number;
  contributions: {
    userId: string;
    contributionId: string;
    collectors: { enrollmentId: string; status: string }[];
  }[];
  integritySessions: { source: string; sourceSessionId: string; errorClass?: string }[];
}

interface SeededWorld {
  driver: ConvexTestDriver;
  owner: { _id: string; tokenIdentifier: string; orgId: string };
  member: { _id: string; tokenIdentifier: string; orgId: string };
  otherOwner: { _id: string; tokenIdentifier: string; orgId: string };
  ownerCred: string;
  memberCred: string;
  foreignCred: string;
  ownerMembership: string;
  memberMembership: string;
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

function seedWorld(
  tier: 'hobby' | 'pro' = 'pro',
  status: 'active' | 'grace' | 'canceled' = 'active',
): SeededWorld {
  const driver = new ConvexTestDriver();
  const ownerId = driver.insert('users', {
    tokenIdentifier: 'https://auth.example/|auth0|owner',
    email: 'owner@example.com',
    enabled: true,
  });
  const memberId = driver.insert('users', {
    tokenIdentifier: 'https://auth.example/|auth0|member',
    email: 'member@example.com',
    enabled: true,
  });
  const otherOwnerId = driver.insert('users', {
    tokenIdentifier: 'https://auth.example/|auth0|other',
    email: 'other@example.com',
    enabled: true,
  });

  const orgId = driver.insert('organizations', { name: 'Acme', ownerId });
  const otherOrgId = driver.insert('organizations', { name: 'Other', ownerId: otherOwnerId });
  driver.patch(ownerId, { orgId });
  driver.patch(memberId, { orgId });
  driver.patch(otherOwnerId, { orgId: otherOrgId });

  const ownerMembership = driver.insert('organizationMembers', {
    orgId,
    userId: ownerId,
    role: 'owner',
    status: 'active',
  });
  const memberMembership = driver.insert('organizationMembers', {
    orgId,
    userId: memberId,
    role: 'member',
    status: 'active',
  });
  driver.insert('organizationMembers', {
    orgId: otherOrgId,
    userId: otherOwnerId,
    role: 'owner',
    status: 'active',
  });

  driver.insert('subscriptions', {
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
  driver.insert('subscriptions', {
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

  const ownerCred = driver.insert('collectorCredentials', {
    hashedSecret: 'hash-owner',
    orgId,
    userId: ownerId,
    collectorId: 'collector-owner',
    status: 'active',
    expiresAt: Date.now() + 60_000,
  });
  const memberCred = driver.insert('collectorCredentials', {
    hashedSecret: 'hash-member',
    orgId,
    userId: memberId,
    collectorId: 'collector-member',
    status: 'active',
    expiresAt: Date.now() + 60_000,
  });
  const foreignCred = driver.insert('collectorCredentials', {
    hashedSecret: 'hash-foreign',
    orgId: otherOrgId,
    userId: otherOwnerId,
    collectorId: 'collector-foreign',
    status: 'active',
    expiresAt: Date.now() + 60_000,
  });

  return {
    driver,
    owner: { _id: ownerId, tokenIdentifier: 'https://auth.example/|auth0|owner', orgId },
    member: { _id: memberId, tokenIdentifier: 'https://auth.example/|auth0|member', orgId },
    otherOwner: {
      _id: otherOwnerId,
      tokenIdentifier: 'https://auth.example/|auth0|other',
      orgId: otherOrgId,
    },
    ownerCred,
    memberCred,
    foreignCred,
    ownerMembership,
    memberMembership,
  };
}

function identity(user: { tokenIdentifier: string }) {
  return { tokenIdentifier: user.tokenIdentifier };
}

const sources = [{ source: 'claude' as const, historyChoice: 'new_only' as const }];
const otherSources = [{ source: 'codex' as const, historyChoice: 'all_history' as const }];

function enrollInput(
  collectorCredentialId: string,
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
      authorizedSources: sources,
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
        existingByKey: { ...existingByKey, authorizedSources: otherSources },
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
  });

  it('denies writes when the server gate, entitlement, or enrollment is closed', () => {
    const base = {
      serverEnabled: true,
      activation: { status: 'active' as const },
      subscription: { tier: 'pro', status: 'active' },
      credential: { status: 'active', orgId: 'org', userId: 'user' },
      enrollment: { status: 'active' as const, authorizedSources: [{ source: 'claude' }] },
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
});

describe('archive control plane', () => {
  it('lets only an authenticated owner atomically create Archive Activation', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    const memberCtx = world.driver.ctx(identity(world.member));

    await expect(call(activate, memberCtx, {})).rejects.toThrow('organization owner');
    const first = await call<ActivateResult>(activate, ownerCtx, {});
    const second = await call<ActivateResult>(activate, ownerCtx, {});
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.activationId).toBe(first.activationId);
    await expect(world.driver.query('archiveActivations').collect()).resolves.toHaveLength(1);
  });

  it('fails closed for hobby, inactive Pro, or a disabled server gate', async () => {
    const hobby = seedWorld('hobby');
    enableArchive();
    await expect(call(activate, hobby.driver.ctx(identity(hobby.owner)), {})).rejects.toThrow(
      'Active Pro entitlement',
    );

    const inactive = seedWorld('pro', 'canceled');
    enableArchive();
    await expect(call(activate, inactive.driver.ctx(identity(inactive.owner)), {})).rejects.toThrow(
      'Active Pro entitlement',
    );

    const gated = seedWorld();
    disableArchive();
    await expect(call(activate, gated.driver.ctx(identity(gated.owner)), {})).rejects.toThrow(
      'not enabled',
    );
  });

  it('records the 100 GB cap and freezes with a 90-day grace deadline when Pro lapses', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    const activation = (await world.driver.query('archiveActivations').collect())[0]!;
    expect(activation.capBytes).toBe(ARCHIVE_CAP_BYTES);
    expect(activation.graceDeadlineAt).toBeUndefined();

    const subscription = (await world.driver.query('subscriptions').collect()).find(
      (row) => row.orgId === world.owner.orgId,
    )!;
    world.driver.patch(subscription._id, { status: 'canceled' });
    const before = Date.now();
    await call(syncLifecycleForOrg, ownerCtx, { orgId: world.owner.orgId });
    const frozen = world.driver.get(activation._id);
    expect(frozen?.status).toBe('frozen');
    expect(frozen?.graceDeadlineAt).toBeGreaterThanOrEqual(before + ARCHIVE_GRACE_MS);
    expect(frozen?.graceDeadlineAt).toBeLessThanOrEqual(Date.now() + ARCHIVE_GRACE_MS);
  });

  it('enrolls only a Collector Credential bound to the same Organization and User', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    const memberCtx = world.driver.ctx(identity(world.member));
    await call(activate, ownerCtx, {});

    await expect(call(enroll, ownerCtx, enrollInput(world.memberCred))).rejects.toThrow(
      'Collector Credential not found',
    );
    await expect(call(enroll, memberCtx, enrollInput(world.foreignCred))).rejects.toThrow(
      'Collector Credential not found',
    );

    const created = await call<EnrollResult>(enroll, memberCtx, enrollInput(world.memberCred));
    expect(created.created).toBe(true);

    const replay = await call<EnrollResult>(enroll, memberCtx, enrollInput(world.memberCred));
    expect(replay.created).toBe(false);
    expect(replay.enrollmentId).toBe(created.enrollmentId);
    const enrollment = world.driver.get(created.enrollmentId);
    expect(enrollment?.authorizedSources).toEqual([
      expect.objectContaining({ source: 'claude', historyChoice: 'new_only' }),
    ]);
    expect(enrollment?.idempotencyKey).toBe(`consent:${world.memberCred}`);
  });

  it('produces one enrollment when two first-use enrollments commit concurrently', async () => {
    enableArchive();
    const world = seedWorld();
    await call(activate, world.driver.ctx(identity(world.owner)), {});

    const results = await Promise.all([
      world.driver.transact(() =>
        call<EnrollResult>(
          enroll,
          world.driver.ctx(identity(world.owner)),
          enrollInput(world.ownerCred),
        ),
      ),
      world.driver.transact(() =>
        call<EnrollResult>(
          enroll,
          world.driver.ctx(identity(world.owner)),
          enrollInput(world.ownerCred),
        ),
      ),
    ]);

    expect(new Set(results.map((result) => result.enrollmentId)).size).toBe(1);
    const enrollments = await world.driver.query('archiveEnrollments').collect();
    expect(enrollments).toHaveLength(1);
    const slots = await world.driver.query('archiveEnrollmentSlots').collect();
    expect(slots).toHaveLength(1);
  });

  it('lets a current member self-enroll after activation without archive-wide read authority', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    const memberCtx = world.driver.ctx(identity(world.member));
    await call(activate, ownerCtx, {});
    await call(enroll, ownerCtx, enrollInput(world.ownerCred));
    await call(enroll, memberCtx, enrollInput(world.memberCred));

    const ownerStatus = await call<StatusResult>(getStatus, ownerCtx, {});
    const memberStatus = await call<StatusResult>(getStatus, memberCtx, {});

    expect(ownerStatus.contributions).toHaveLength(2);
    expect(ownerStatus.storedBytes).toBe(0);
    expect(ownerStatus.enrolledCollectorCount).toBe(2);
    expect(memberStatus.contributions).toHaveLength(1);
    expect(memberStatus.contributions[0]?.userId).toBe(world.member._id);
    expect(memberStatus.storedBytes).toBeNull();
    expect(memberStatus.enrolledCollectorCount).toBe(1);

    await expect(call(activate, memberCtx, {})).rejects.toThrow('organization owner');
    await expect(
      call(revokeEnrollment, memberCtx, {
        enrollmentId: ownerStatus.contributions[0]!.collectors[0]!.enrollmentId,
      }),
    ).rejects.toThrow('organization owner');
  });

  it('keeps a newly supported Source unauthorized until it is explicitly added', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    const enrolled = await call<EnrollResult>(enroll, ownerCtx, enrollInput(world.ownerCred));

    const denied = await call<WriteDecision>(authorizeArchiveWrite, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      source: 'codex',
    });
    expect(denied).toEqual({ allowed: false, reason: 'source_unauthorized' });

    await call(addAuthorizedSource, ownerCtx, {
      enrollmentId: enrolled.enrollmentId,
      source: 'codex',
      historyChoice: 'all_history',
    });
    const allowed = await call<WriteDecision>(authorizeArchiveWrite, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      source: 'codex',
    });
    expect(allowed).toMatchObject({ allowed: true });
  });

  it('rejects stale membership and cross-tenant IDs', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    const memberCtx = world.driver.ctx(identity(world.member));
    await call(activate, ownerCtx, {});
    world.driver.patch(world.memberMembership, { status: 'removed' });

    await expect(call(enroll, memberCtx, enrollInput(world.memberCred))).rejects.toThrow(
      'Not an active organization member',
    );

    const foreign = world.driver.ctx(identity(world.otherOwner));
    await expect(call(getStatus, foreign, {})).resolves.toMatchObject({ lifecycle: 'not_enabled' });
    await call(activate, foreign, {});
    await expect(call(enroll, foreign, enrollInput(world.ownerCred))).rejects.toThrow(
      'Collector Credential not found',
    );
  });

  it('invalidates enrollment on unenroll, owner revocation, and member removal without deleting the contribution', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    const memberCtx = world.driver.ctx(identity(world.member));
    await call(activate, ownerCtx, {});
    const ownerEnroll = await call<EnrollResult>(enroll, ownerCtx, enrollInput(world.ownerCred));
    const memberEnroll = await call<EnrollResult>(enroll, memberCtx, enrollInput(world.memberCred));

    await call(unenroll, ownerCtx, { enrollmentId: ownerEnroll.enrollmentId });
    expect(world.driver.get(ownerEnroll.enrollmentId)?.status).toBe('unenrolled');
    expect(world.driver.get(ownerEnroll.contributionId)?.status).toBe('unenrolled');
    expect(
      await call(authorizeArchiveWrite, ownerCtx, { collectorCredentialId: world.ownerCred }),
    ).toEqual({ allowed: false, reason: 'enrollment_invalid' });

    await call(revokeEnrollment, ownerCtx, { enrollmentId: memberEnroll.enrollmentId });
    expect(world.driver.get(memberEnroll.enrollmentId)?.status).toBe('revoked');
    expect(world.driver.get(memberEnroll.contributionId)).toMatchObject({
      orgId: world.member.orgId,
      userId: world.member._id,
    });

    const member2Cred = world.driver.insert('collectorCredentials', {
      hashedSecret: 'hash-member-2',
      orgId: world.member.orgId,
      userId: world.member._id,
      collectorId: 'collector-member-2',
      status: 'active',
      expiresAt: Date.now() + 60_000,
    });
    world.driver.patch(world.memberMembership, { status: 'active' });
    await call(enroll, memberCtx, enrollInput(member2Cred));
    await call(removeMember, ownerCtx, { memberId: world.memberMembership });
    const remaining = (await world.driver.query('archiveEnrollments').collect()).filter(
      (row) => row.userId === world.member._id && row.status === 'active',
    );
    expect(remaining).toHaveLength(0);
    expect(
      (await world.driver.query('archiveContributions').collect()).some(
        (row) => row.userId === world.member._id,
      ),
    ).toBe(true);
  });

  it('creates a new consent record on re-enrollment instead of reviving the revoked one', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    const first = await call<EnrollResult>(enroll, ownerCtx, enrollInput(world.ownerCred));
    await call(unenroll, ownerCtx, { enrollmentId: first.enrollmentId });
    const second = await call<EnrollResult>(
      enroll,
      ownerCtx,
      enrollInput(world.ownerCred, {
        authorizedSources: otherSources,
        idempotencyKey: `consent:${world.ownerCred}:renew`,
      }),
    );
    expect(second.enrollmentId).not.toBe(first.enrollmentId);
    expect(second.created).toBe(true);
    expect(world.driver.get(first.enrollmentId)?.status).toBe('unenrolled');
    expect(world.driver.get(second.enrollmentId)).toMatchObject({
      status: 'active',
      idempotencyKey: `consent:${world.ownerCred}:renew`,
      authorizedSources: [
        expect.objectContaining({ source: 'codex', historyChoice: 'all_history' }),
      ],
    });
  });

  it('replays a delayed old consent after unenroll or revoke without reactivating it', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    const memberCtx = world.driver.ctx(identity(world.member));
    await call(activate, ownerCtx, {});

    const ownerFirst = await call<EnrollResult>(enroll, ownerCtx, enrollInput(world.ownerCred));
    await call(unenroll, ownerCtx, { enrollmentId: ownerFirst.enrollmentId });
    const delayedUnenrollReplay = await call<EnrollResult>(
      enroll,
      ownerCtx,
      enrollInput(world.ownerCred),
    );
    expect(delayedUnenrollReplay).toEqual({
      enrollmentId: ownerFirst.enrollmentId,
      contributionId: ownerFirst.contributionId,
      created: false,
    });
    expect(world.driver.get(ownerFirst.enrollmentId)?.status).toBe('unenrolled');
    expect(
      await call(authorizeArchiveWrite, ownerCtx, { collectorCredentialId: world.ownerCred }),
    ).toEqual({ allowed: false, reason: 'enrollment_invalid' });

    const memberFirst = await call<EnrollResult>(enroll, memberCtx, enrollInput(world.memberCred));
    await call(revokeEnrollment, ownerCtx, { enrollmentId: memberFirst.enrollmentId });
    const delayedRevokeReplay = await call<EnrollResult>(
      enroll,
      memberCtx,
      enrollInput(world.memberCred),
    );
    expect(delayedRevokeReplay).toEqual({
      enrollmentId: memberFirst.enrollmentId,
      contributionId: memberFirst.contributionId,
      created: false,
    });
    expect(world.driver.get(memberFirst.enrollmentId)?.status).toBe('revoked');
    expect(
      await call(authorizeArchiveWrite, memberCtx, { collectorCredentialId: world.memberCred }),
    ).toEqual({ allowed: false, reason: 'enrollment_invalid' });
    expect(await world.driver.query('archiveEnrollments').collect()).toHaveLength(2);
  });

  it('fails when the same idempotency key is reused with a different consent payload', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    const first = await call<EnrollResult>(enroll, ownerCtx, enrollInput(world.ownerCred));

    await expect(
      call(enroll, ownerCtx, enrollInput(world.ownerCred, { authorizedSources: otherSources })),
    ).rejects.toThrow('does not match the original consent');
    expect(world.driver.get(first.enrollmentId)).toMatchObject({
      status: 'active',
      authorizedSources: [expect.objectContaining({ source: 'claude', historyChoice: 'new_only' })],
    });

    await call(unenroll, ownerCtx, { enrollmentId: first.enrollmentId });
    await expect(
      call(enroll, ownerCtx, enrollInput(world.ownerCred, { authorizedSources: otherSources })),
    ).rejects.toThrow('does not match the original consent');
    expect(world.driver.get(first.enrollmentId)?.status).toBe('unenrolled');
    expect(await world.driver.query('archiveEnrollments').collect()).toHaveLength(1);
  });

  it('rejects a new consent key while the Collector is still enrolled', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    await call(enroll, ownerCtx, enrollInput(world.ownerCred));
    await expect(
      call(
        enroll,
        ownerCtx,
        enrollInput(world.ownerCred, { idempotencyKey: `consent:${world.ownerCred}:other` }),
      ),
    ).rejects.toThrow('already enrolled');
  });

  it('lets collector heartbeats change only timestamped local fields', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    await call(enroll, ownerCtx, enrollInput(world.ownerCred));

    await call(reportHeartbeat, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 42,
      localError: 'spool_full',
      observedAt: 1234,
    });
    const enrollment = (await world.driver.query('archiveEnrollments').collect())[0]!;
    expect(enrollment.pendingSpoolBytes).toBe(42);
    expect(enrollment.localError).toBe('spool_full');
    expect(enrollment.localObservedAt).toBe(1234);

    const before = world.driver.get(
      (await world.driver.query('archiveStatuses').collect())[0]!._id,
    );
    await call(reportCollectorHeartbeat, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      pendingSpoolBytes: 7,
      observedAt: 5678,
    });
    const after = world.driver.get(before!._id);
    expect(after?.storedBytes).toBe(before?.storedBytes);
    expect(after?.lifecycle).toBe(before?.lifecycle);
    expect(after?.lastDurableAcknowledgedAt).toBe(before?.lastDurableAcknowledgedAt);
  });

  it('lets Archive API own durable acknowledgement, server bytes, and lifecycle', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    await call(enroll, ownerCtx, enrollInput(world.ownerCred));

    await call(applyServerStatus, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      storedBytes: 99,
      lastDurableAcknowledgedAt: 888,
      lifecycle: 'blocked',
    });
    await call(upsertSessionIntegrity, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
      sourceSessionId: 'sess-1',
      errorClass: 'chain_mismatch',
    });

    const status = await call<StatusResult>(getStatus, ownerCtx, {});
    expect(status.storedBytes).toBe(99);
    expect(status.lastDurableAcknowledgedAt).toBe(888);
    expect(status.lifecycle).toBe('blocked');
    expect(status.integritySessions).toEqual([
      expect.objectContaining({
        source: 'claude',
        sourceSessionId: 'sess-1',
        errorClass: 'chain_mismatch',
      }),
    ]);

    const enrollment = (await world.driver.query('archiveEnrollments').collect())[0]!;
    expect(enrollment.pendingSpoolBytes).toBeUndefined();
  });

  it('does not let enrollment overwrite Archive API lifecycle or durable bytes', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    const memberCtx = world.driver.ctx(identity(world.member));
    await call(activate, ownerCtx, {});
    await call(enroll, ownerCtx, enrollInput(world.ownerCred));
    await call(applyServerStatus, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      storedBytes: ARCHIVE_CAP_BYTES,
      lastDurableAcknowledgedAt: 999,
      lifecycle: 'blocked',
    });

    await call(enroll, memberCtx, enrollInput(world.memberCred));

    const status = await call<StatusResult>(getStatus, ownerCtx, {});
    expect(status.lifecycle).toBe('blocked');
    expect(status.storedBytes).toBe(ARCHIVE_CAP_BYTES);
    expect(status.lastDurableAcknowledgedAt).toBe(999);
    expect(status.enrolledCollectorCount).toBe(2);
  });

  it('preserves deleting through billing sync after entitlement is regained', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    await call(enroll, ownerCtx, enrollInput(world.ownerCred));
    await call(applyServerStatus, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      storedBytes: 50,
      lastDurableAcknowledgedAt: 111,
      lifecycle: 'deleting',
    });

    const deniedWhileDeleting = await call<WriteDecision>(authorizeArchiveWrite, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
    });
    expect(deniedWhileDeleting).toEqual({ allowed: false, reason: 'deleting' });

    const subscription = (await world.driver.query('subscriptions').collect()).find(
      (row) => row.orgId === world.owner.orgId,
    )!;
    world.driver.patch(subscription._id, { status: 'canceled' });
    await call(syncLifecycleForOrg, ownerCtx, { orgId: world.owner.orgId });
    world.driver.patch(subscription._id, { status: 'active' });
    await call(syncLifecycleForOrg, ownerCtx, { orgId: world.owner.orgId });

    const activation = (await world.driver.query('archiveActivations').collect())[0]!;
    expect(activation.status).toBe('deleting');
    const status = await call<StatusResult>(getStatus, ownerCtx, {});
    expect(status.lifecycle).toBe('deleting');
    expect(status.storedBytes).toBe(50);
    expect(status.lastDurableAcknowledgedAt).toBe(111);

    const stillDenied = await call<WriteDecision>(authorizeArchiveWrite, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
    });
    expect(stillDenied).toEqual({ allowed: false, reason: 'deleting' });
  });

  it('repairs duplicate enrollment slots without throwing on later reads', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    const first = await call<EnrollResult>(enroll, ownerCtx, enrollInput(world.ownerCred));

    const extraEnrollment = world.driver.insert('archiveEnrollments', {
      orgId: world.owner.orgId,
      userId: world.owner._id,
      collectorCredentialId: world.ownerCred,
      collectorId: 'collector-owner',
      contributionId: first.contributionId,
      idempotencyKey: `consent:${world.ownerCred}:extra`,
      authorizedSources: [{ source: 'codex', historyChoice: 'all_history', authorizedAt: 1 }],
      status: 'active',
      createdAt: Date.now(),
    });
    world.driver.insert('archiveEnrollmentSlots', {
      orgId: world.owner.orgId,
      collectorCredentialId: world.ownerCred,
      currentEnrollmentId: extraEnrollment,
    });

    const replay = await call<EnrollResult>(enroll, ownerCtx, enrollInput(world.ownerCred));
    expect(replay.enrollmentId).toBe(first.enrollmentId);
    expect(replay.created).toBe(false);
    await expect(world.driver.query('archiveEnrollmentSlots').collect()).resolves.toHaveLength(1);

    const allowed = await call<WriteDecision>(authorizeArchiveWrite, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      source: 'claude',
    });
    expect(allowed).toMatchObject({ allowed: true, enrollmentId: first.enrollmentId });
  });

  it('keeps deleting terminal when entitlement syncs again', async () => {
    enableArchive();
    const world = seedWorld();
    const ownerCtx = world.driver.ctx(identity(world.owner));
    await call(activate, ownerCtx, {});
    await call(enroll, ownerCtx, enrollInput(world.ownerCred));
    await call(applyServerStatus, ownerCtx, {
      collectorCredentialId: world.ownerCred,
      lifecycle: 'deleting',
    });

    const activation = (await world.driver.query('archiveActivations').collect())[0]!;
    expect(activation.status).toBe('deleting');
    expect(
      await call<WriteDecision>(authorizeArchiveWrite, ownerCtx, {
        collectorCredentialId: world.ownerCred,
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });

    await call(syncLifecycleForOrg, ownerCtx, { orgId: world.owner.orgId });
    expect(world.driver.get(activation._id)?.status).toBe('deleting');
    expect(
      await call<WriteDecision>(authorizeArchiveWrite, ownerCtx, {
        collectorCredentialId: world.ownerCred,
      }),
    ).toEqual({ allowed: false, reason: 'deleting' });

    const subscription = (await world.driver.query('subscriptions').collect()).find(
      (row) => row.orgId === world.owner.orgId,
    )!;
    world.driver.patch(subscription._id, { status: 'canceled' });
    await call(syncLifecycleForOrg, ownerCtx, { orgId: world.owner.orgId });
    expect(world.driver.get(activation._id)?.status).toBe('deleting');
    expect(world.driver.get(activation._id)?.graceDeadlineAt).toBeUndefined();
  });
});
