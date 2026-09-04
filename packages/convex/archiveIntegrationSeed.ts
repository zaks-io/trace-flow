import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

const ARCHIVE_INTEGRATION_TEST_GATE = 'TRACE_FLOW_ARCHIVE_INTEGRATION_TEST_ENABLED';
const ARCHIVE_INTEGRATION_ORG_NAME_PREFIX = 'Archive concurrency test ';

function assertArchiveIntegrationTestEnabled() {
  if (process.env[ARCHIVE_INTEGRATION_TEST_GATE] !== 'true') {
    throw new Error(
      'Archive integration seed is disabled outside an explicit test deployment gate',
    );
  }
}

function assertSeededArchiveIntegrationOrg<T extends { name: string }>(
  organization: T | null,
): asserts organization is T {
  if (!organization?.name.startsWith(ARCHIVE_INTEGRATION_ORG_NAME_PREFIX)) {
    throw new Error('Archive integration cleanup targets seeded test organizations only');
  }
}

// This internal seed gives the opt-in backend test an isolated owner and Collector Credential
// without adding a public auth bypass or reusing a developer's existing organization.
const seedResultValidator = v.object({
  orgId: v.id('organizations'),
  tokenIdentifier: v.string(),
  collectorCredentialId: v.id('collectorCredentials'),
  idempotencyKey: v.string(),
});

export const seedConcurrentEnrollment = internalMutation({
  args: {},
  returns: seedResultValidator,
  handler: async (ctx) => {
    assertArchiveIntegrationTestEnabled();
    const runId = crypto.randomUUID();
    const tokenIdentifier = `archive-concurrency-test|${runId}`;
    const now = Date.now();
    const userId = await ctx.db.insert('users', {
      tokenIdentifier,
      email: `${runId}@archive-concurrency-test.invalid`,
      enabled: true,
    });
    const orgId = await ctx.db.insert('organizations', {
      name: `${ARCHIVE_INTEGRATION_ORG_NAME_PREFIX}${runId}`,
      ownerId: userId,
    });
    await ctx.db.patch(userId, { orgId });
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId,
      role: 'owner',
      status: 'active',
    });
    await ctx.db.insert('subscriptions', {
      orgId,
      tier: 'pro',
      status: 'active',
      monthlyUnits: 1_000,
      addonUnits: 0,
      currentPeriodStart: now,
      currentPeriodEnd: now + 86_400_000,
      currentPeriodOverageSpentCents: 0,
      addonPurchaseCount: 0,
    });
    const collectorCredentialId = await ctx.db.insert('collectorCredentials', {
      hashedSecret: `archive-concurrency-test-${runId}`,
      orgId,
      userId,
      collectorId: `archive-concurrency-test-${runId}`,
      status: 'active',
      expiresAt: now + 3_600_000,
    });

    return {
      orgId,
      tokenIdentifier,
      collectorCredentialId,
      idempotencyKey: `archive-concurrency-test-${runId}`,
    };
  },
});

export const cleanupConcurrentEnrollment = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
  handler: async (ctx, { orgId }) => {
    assertArchiveIntegrationTestEnabled();
    const organization = await ctx.db.get(orgId);
    assertSeededArchiveIntegrationOrg(organization);
    for (const row of await ctx.db
      .query('archiveAuditEvents')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('archiveSessionIntegrity')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('archiveEnrollmentSlots')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('archiveEnrollments')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('archiveContributions')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('archiveStatuses')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('archiveActivations')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('collectorCredentials')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db
      .query('users')
      .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
      .collect()) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.delete(organization._id);
    return null;
  },
});
