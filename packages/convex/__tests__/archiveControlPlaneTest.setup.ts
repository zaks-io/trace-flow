import { afterEach } from 'vitest';
import type { Id } from '../_generated/dataModel';
import { ARCHIVE_ENABLED_ENV } from '../archiveLib';
import { initConvexTest, type ArchiveTestConvex } from './convexTest.setup';

export interface SeededWorld {
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

export function enableArchive() {
  process.env[ARCHIVE_ENABLED_ENV] = 'true';
}

export function disableArchive() {
  delete process.env[ARCHIVE_ENABLED_ENV];
}

afterEach(() => {
  disableArchive();
  delete process.env.TRACE_FLOW_ARCHIVE_INTEGRATION_TEST_ENABLED;
});

export async function seedWorld(
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

export function asUser(world: SeededWorld, user: { tokenIdentifier: string }) {
  return world.t.withIdentity({ tokenIdentifier: user.tokenIdentifier });
}

export const sources = [{ source: 'claude' as const, historyChoice: 'new_only' as const }];
export const otherSources = [{ source: 'codex' as const, historyChoice: 'all_history' as const }];

export function enrollInput(
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
