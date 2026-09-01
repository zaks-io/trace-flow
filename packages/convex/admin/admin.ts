import {
  query,
  action,
  internalAction,
  internalMutation,
  type ActionCtx,
} from '../_generated/server';
import { v } from 'convex/values';
import { requireAdmin, extractSub } from '../auth/users';
import { requireAuthenticated } from '../auth/auth';
import { internal } from '../_generated/api';
import { organizationValidator } from '../validators';
import { getStripeClient } from '../billing/stripe';
import { scheduleKVSync } from '../billing/subscriptions';
import { ensureOrgHasSubscription } from '../auth/organizations';
import { TIER_CONFIG } from '@trace-flow/types';
import type { Id } from '../_generated/dataModel';

async function requireAdminAction(ctx: ActionCtx) {
  await requireAuthenticated(ctx);
  const isAdmin = await ctx.runQuery(internal.auth.users.isAdminInternal);
  if (!isAdmin) throw new Error('Admin access required');
}

export const stats = query({
  args: {},
  returns: v.object({
    userCount: v.number(),
    orgCount: v.number(),
    apiKeyCount: v.number(),
    modelPricingCount: v.number(),
    subscriptionCount: v.number(),
    tierBreakdown: v.object({
      hobby: v.number(),
      pro: v.number(),
    }),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const [users, orgs, apiKeys, modelPricing, subscriptions] = await Promise.all([
      ctx.db.query('users').collect(),
      ctx.db.query('organizations').collect(),
      ctx.db.query('apiKeys').collect(),
      ctx.db.query('modelPricing').collect(),
      ctx.db.query('subscriptions').collect(),
    ]);

    const tierBreakdown = { hobby: 0, pro: 0 };
    for (const sub of subscriptions) {
      if (sub.tier === 'hobby' || sub.tier === 'pro') {
        tierBreakdown[sub.tier]++;
      }
    }

    return {
      userCount: users.length,
      orgCount: orgs.filter((o) => !o.deletedAt).length,
      apiKeyCount: apiKeys.length,
      modelPricingCount: modelPricing.length,
      subscriptionCount: subscriptions.length,
      tierBreakdown,
    };
  },
});

export const listOrgs = query({
  args: {},
  returns: v.array(organizationValidator),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const orgs = await ctx.db.query('organizations').collect();
    return orgs.filter((o) => !o.deletedAt);
  },
});

// --- Subscription Health ---

const orgHealthIssue = v.union(
  v.literal('no_subscription'),
  v.literal('period_expired'),
  v.literal('suspended'),
  v.literal('canceled'),
);

const orgHealthRowValidator = v.object({
  _id: v.id('organizations'),
  name: v.string(),
  ownerEmail: v.optional(v.string()),
  subscription: v.union(
    v.null(),
    v.object({
      _id: v.id('subscriptions'),
      tier: v.union(v.literal('hobby'), v.literal('pro')),
      status: v.union(
        v.literal('active'),
        v.literal('grace'),
        v.literal('suspended'),
        v.literal('canceled'),
      ),
      monthlyUnits: v.number(),
      addonUnits: v.number(),
      currentPeriodStart: v.number(),
      currentPeriodEnd: v.number(),
      stripeSubscriptionId: v.optional(v.string()),
    }),
  ),
  issues: v.array(orgHealthIssue),
});

export const listOrgSubscriptionHealth = query({
  args: {},
  returns: v.array(orgHealthRowValidator),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const orgs = await ctx.db.query('organizations').collect();
    const activeOrgs = orgs.filter((o) => !o.deletedAt);

    // Batch-load subscriptions and owners upfront to avoid N+1 queries
    const [allSubs, allOwners] = await Promise.all([
      ctx.db.query('subscriptions').collect(),
      Promise.all(activeOrgs.map((org) => ctx.db.get(org.ownerId))),
    ]);
    const subsByOrg = new Map(allSubs.map((s) => [s.orgId, s]));
    const ownersByOrg = new Map(activeOrgs.map((org, i) => [org._id, allOwners[i]] as const));

    const now = Date.now();
    const rows = activeOrgs.map((org) => {
      const sub = subsByOrg.get(org._id);
      const owner = ownersByOrg.get(org._id);

      const issues: ('no_subscription' | 'period_expired' | 'suspended' | 'canceled')[] = [];
      if (!sub) {
        issues.push('no_subscription');
      } else {
        if (sub.status === 'suspended') issues.push('suspended');
        if (sub.status === 'canceled') issues.push('canceled');
        if (sub.currentPeriodEnd < now) issues.push('period_expired');
      }

      return {
        _id: org._id,
        name: org.name,
        ownerEmail: owner?.email,
        subscription: sub
          ? {
              _id: sub._id,
              tier: sub.tier,
              status: sub.status,
              monthlyUnits: sub.monthlyUnits,
              addonUnits: sub.addonUnits,
              currentPeriodStart: sub.currentPeriodStart,
              currentPeriodEnd: sub.currentPeriodEnd,
              stripeSubscriptionId: sub.stripeSubscriptionId,
            }
          : null,
        issues,
      };
    });

    // Sort: orgs with issues first
    rows.sort((a, b) => b.issues.length - a.issues.length);
    return rows;
  },
});

export const forceActivateSubscription = internalMutation({
  args: {
    orgId: v.id('organizations'),
    tier: v.optional(v.union(v.literal('hobby'), v.literal('pro'))),
    monthlyUnits: v.optional(v.number()),
    periodDays: v.optional(v.number()),
  },
  returns: v.id('subscriptions'),
  handler: async (ctx, args) => {
    let sub = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();

    if (!sub) {
      await ensureOrgHasSubscription(ctx, args.orgId);
      sub = await ctx.db
        .query('subscriptions')
        .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
        .first();
      if (!sub) throw new Error('Failed to create subscription');
    }

    // Cancel pending schedulers
    for (const id of [sub.gracePeriodSchedulerId, sub.deletionSchedulerId]) {
      if (id) {
        try {
          await ctx.scheduler.cancel(id);
        } catch {
          // Already completed or canceled
        }
      }
    }

    const tier = args.tier ?? sub.tier ?? 'hobby';
    const monthlyUnits = args.monthlyUnits ?? TIER_CONFIG[tier].monthlyUnits;
    const periodDays = Math.max(1, Math.min(365, Math.floor(args.periodDays ?? 30)));
    const now = Date.now();

    await ctx.db.patch(sub._id, {
      status: 'active',
      tier,
      monthlyUnits,
      currentPeriodStart: now,
      currentPeriodEnd: now + periodDays * 24 * 60 * 60 * 1000,
      currentPeriodOverageSpentCents: 0,
      gracePeriodSchedulerId: undefined,
      deletionSchedulerId: undefined,
    });

    await scheduleKVSync(ctx, sub._id);
    return sub._id;
  },
});

export const forceActivateAndVerify = action({
  args: {
    orgId: v.id('organizations'),
    tier: v.optional(v.union(v.literal('hobby'), v.literal('pro'))),
    monthlyUnits: v.optional(v.number()),
    periodDays: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    kvVerified: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdminAction(ctx);

    await ctx.runMutation(internal.admin.admin.forceActivateSubscription, {
      orgId: args.orgId,
      tier: args.tier,
      monthlyUnits: args.monthlyUnits,
      periodDays: args.periodDays,
    });

    // Sync directly rather than relying on the scheduled sync
    const sub = await ctx.runQuery(internal.billing.subscriptions.getByOrgId, {
      orgId: args.orgId,
    });
    if (!sub) throw new Error('Subscription not found after activation');

    await ctx.runAction(internal.integrations.cloudflare.syncSubscriptionToKV, {
      orgId: sub.orgId,
      tier: sub.tier,
      monthlyUnits: sub.monthlyUnits,
      addonUnits: sub.addonUnits,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      autoOverage: sub.autoOverage,
      overageCapCents: sub.overageCapCents,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    });

    const kvVerified = await ctx.runAction(internal.integrations.cloudflare.checkKeyInKV, {
      key: `sub:${args.orgId}`,
    });

    return { success: true, kvVerified };
  },
});

// --- Org Deletion ---

const deleteResultValidator = v.object({
  tinybirdResults: v.union(
    v.object({ deleted: v.literal(false), reason: v.string() }),
    v.object({
      deleted: v.literal(true),
      results: v.record(
        v.string(),
        v.object({ success: v.boolean(), error: v.optional(v.string()) }),
      ),
    }),
  ),
  convexDeleted: v.object({
    apiKeys: v.number(),
    collectorCredentials: v.number(),
    usage: v.number(),
    addonPurchases: v.number(),
    membersRemoved: v.number(),
    invites: v.number(),
    alerts: v.number(),
    mcpSessions: v.number(),
    mcpRefreshTokens: v.number(),
  }),
  stripeCanceled: v.boolean(),
});

export const deleteOrgData = action({
  args: { orgId: v.id('organizations') },
  returns: deleteResultValidator,
  handler: async (ctx, args) => {
    await requireAdminAction(ctx);
    return await deleteOrgDataImpl(ctx, args.orgId);
  },
});

export const deleteOrgDataScheduled = internalAction({
  args: { orgId: v.id('organizations') },
  returns: deleteResultValidator,
  handler: async (ctx, args) => {
    // Guard: skip if org was already deleted (e.g. admin deleted during 30-day window)
    const org = await ctx.runQuery(internal.auth.organizations.getByIdInternal, { id: args.orgId });
    if (!org || org.deletedAt) {
      const empty = { deleted: false as const, reason: 'Organization already deleted' };
      return {
        tinybirdResults: empty,
        convexDeleted: {
          apiKeys: 0,
          collectorCredentials: 0,
          usage: 0,
          addonPurchases: 0,
          membersRemoved: 0,
          invites: 0,
          alerts: 0,
          mcpSessions: 0,
          mcpRefreshTokens: 0,
        },
        stripeCanceled: false,
      };
    }
    return await deleteOrgDataImpl(ctx, args.orgId);
  },
});

async function deleteOrgDataImpl(ctx: ActionCtx, orgId: Id<'organizations'>) {
  // IMPORTANT: Tinybird deletion must run BEFORE Convex record deletion.
  // deleteOrgTraces queries API keys from Convex to build the SQL WHERE clause.
  const tinybirdResults = await ctx.runAction(internal.integrations.tinybird.deleteOrgTraces, {
    orgId,
  });

  // 2. Delete Convex records in paginated batches to stay under mutation limits
  const convexDeleted = {
    apiKeys: 0,
    collectorCredentials: 0,
    usage: 0,
    addonPurchases: 0,
    membersRemoved: 0,
    invites: 0,
    alerts: 0,
    mcpSessions: 0,
    mcpRefreshTokens: 0,
  };
  let hasMore = true;
  while (hasMore) {
    const batch = await ctx.runMutation(internal.admin.admin.deleteOrgRecordsBatch, { orgId });
    for (const key of Object.keys(convexDeleted) as (keyof typeof convexDeleted)[]) {
      convexDeleted[key] += batch.counts[key];
    }
    hasMore = batch.hasMore;
  }

  // 3. Cancel Stripe subscription if active
  let stripeCanceled = false;
  const subscription = await ctx.runQuery(internal.billing.subscriptions.getByOrgId, { orgId });
  if (subscription?.stripeSubscriptionId) {
    try {
      const stripe = getStripeClient();
      await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
      stripeCanceled = true;
    } catch (e) {
      console.error('Failed to cancel Stripe subscription:', e);
    }
  }

  // 4. Delete subscription and mark org as deleted
  await ctx.runMutation(internal.admin.admin.finalizeOrgDeletion, { orgId });

  return { tinybirdResults, convexDeleted, stripeCanceled };
}

const deleteBatchCountsValidator = v.object({
  apiKeys: v.number(),
  collectorCredentials: v.number(),
  usage: v.number(),
  addonPurchases: v.number(),
  membersRemoved: v.number(),
  invites: v.number(),
  alerts: v.number(),
  mcpSessions: v.number(),
  mcpRefreshTokens: v.number(),
});

const PAGE_SIZE = 500;

/**
 * Deletes up to PAGE_SIZE org-related records per call. Returns hasMore=true
 * if there are remaining records — the caller (action) loops until done.
 * This keeps each mutation well under Convex's 8096 document op limit.
 */
export const deleteOrgRecordsBatch = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.object({
    counts: deleteBatchCountsValidator,
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const counts = {
      apiKeys: 0,
      collectorCredentials: 0,
      usage: 0,
      addonPurchases: 0,
      membersRemoved: 0,
      invites: 0,
      alerts: 0,
      mcpSessions: 0,
      mcpRefreshTokens: 0,
    };
    let ops = 0;

    // Helper: delete up to remaining budget from a query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function deleteBatch<T extends { _id: any }>(
      items: T[],
      key: keyof typeof counts,
    ): Promise<boolean> {
      for (const item of items) {
        if (ops >= PAGE_SIZE) return true;
        await ctx.db.delete(item._id);
        counts[key]++;
        ops++;
      }
      // A batch that consumes the whole page budget may have left more rows behind (a full
      // take() page), so signal the driver to run again rather than falling through to
      // hasMore:false and orphaning the remainder.
      return ops >= PAGE_SIZE;
    }

    // Delete API keys. Also purge them from the proxy edge KV, or the deleted org's keys keep
    // authenticating at the edge until their (possibly far-future) expiry.
    const apiKeys = await ctx.db
      .query('apiKeys')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .take(PAGE_SIZE);
    for (const apiKey of apiKeys) {
      if (ops >= PAGE_SIZE) return { counts, hasMore: true };
      await ctx.db.delete(apiKey._id);
      await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.deleteKeyFromKV, {
        key: apiKey.key,
      });
      counts.apiKeys++;
      ops++;
    }
    if (apiKeys.length >= PAGE_SIZE) return { counts, hasMore: true };

    // Delete Collector Credentials and purge them from the collector edge KV, otherwise the deleted
    // org's collectors keep ingesting until their secret's own expiry.
    const collectorCreds = await ctx.db
      .query('collectorCredentials')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .take(PAGE_SIZE - ops);
    for (const cred of collectorCreds) {
      if (ops >= PAGE_SIZE) return { counts, hasMore: true };
      await ctx.db.delete(cred._id);
      await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.deleteCollectorCredFromKV, {
        hashedSecret: cred.hashedSecret,
      });
      counts.collectorCredentials++;
      ops++;
    }
    if (ops >= PAGE_SIZE) return { counts, hasMore: true };

    // Delete usage records
    const usageRecords = await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) => q.eq('orgId', args.orgId))
      .take(PAGE_SIZE - ops);
    if (await deleteBatch(usageRecords, 'usage')) return { counts, hasMore: true };

    // Delete addon purchases
    const addons = await ctx.db
      .query('addonPurchases')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .take(PAGE_SIZE - ops);
    if (await deleteBatch(addons, 'addonPurchases')) return { counts, hasMore: true };

    // Mark members as removed and clean up per-member data
    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .take(PAGE_SIZE - ops);
    for (const member of members) {
      if (ops >= PAGE_SIZE) return { counts, hasMore: true };

      if (member.status !== 'removed') {
        await ctx.db.patch(member._id, { status: 'removed', removedAt: Date.now() });
        // Drop the member's user→org routing entry from KV so it doesn't dangle to the deleted org.
        const memberUser = await ctx.db.get(member.userId);
        const sub = memberUser ? extractSub(memberUser.tokenIdentifier) : null;
        if (sub) {
          await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.deleteUserOrgFromKV, {
            sub,
          });
        }
        counts.membersRemoved++;
        ops++;
      }

      const alerts = await ctx.db
        .query('alerts')
        .withIndex('by_user_id', (q) => q.eq('userId', member.userId))
        .take(PAGE_SIZE - ops);
      if (await deleteBatch(alerts, 'alerts')) return { counts, hasMore: true };

      const sessions = await ctx.db
        .query('mcpSessions')
        .withIndex('by_user_id', (q) => q.eq('userId', member.userId))
        .take(PAGE_SIZE - ops);
      if (await deleteBatch(sessions, 'mcpSessions')) return { counts, hasMore: true };

      const tokens = await ctx.db
        .query('mcpRefreshTokens')
        .withIndex('by_user_id', (q) => q.eq('userId', member.userId))
        .take(PAGE_SIZE - ops);
      if (await deleteBatch(tokens, 'mcpRefreshTokens')) return { counts, hasMore: true };
    }

    // Delete invites
    const invites = await ctx.db
      .query('invites')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', args.orgId))
      .take(PAGE_SIZE - ops);
    if (await deleteBatch(invites, 'invites')) return { counts, hasMore: true };

    // The member patch loop increments ops without going through deleteBatch, so re-check the
    // budget here: a fully-consumed page may have more members/invites still to process.
    return { counts, hasMore: ops >= PAGE_SIZE };
  },
});

export const finalizeOrgDeletion = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Delete subscription record
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (subscription) {
      // Cancel any pending schedulers (try/catch: jobs may have already completed)
      for (const id of [subscription.gracePeriodSchedulerId, subscription.deletionSchedulerId]) {
        if (id) {
          try {
            await ctx.scheduler.cancel(id);
          } catch {
            // Already completed or canceled
          }
        }
      }
      await ctx.db.delete(subscription._id);
    }

    // Mark org as deleted
    const org = await ctx.db.get(args.orgId);
    if (org) {
      await ctx.db.patch(args.orgId, { deletedAt: Date.now() });
    }
  },
});
