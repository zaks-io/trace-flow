import {
  query,
  action,
  internalAction,
  internalMutation,
  type ActionCtx,
} from './_generated/server';
import { v } from 'convex/values';
import { requireAdmin } from './users';
import { requireTraceFlowRole } from './auth';
import { internal } from './_generated/api';
import { organizationValidator } from './validators';
import { getStripeClient } from './stripe';
import type { Id } from './_generated/dataModel';

async function requireAdminAction(ctx: ActionCtx) {
  await requireTraceFlowRole(ctx);
  const isAdmin = await ctx.runQuery(internal.users.isAdminInternal);
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
    const org = await ctx.runQuery(internal.organizations.getByIdInternal, { id: args.orgId });
    if (!org || org.deletedAt) {
      const empty = { deleted: false as const, reason: 'Organization already deleted' };
      return {
        tinybirdResults: empty,
        convexDeleted: {
          apiKeys: 0,
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
  const tinybirdResults = await ctx.runAction(internal.tinybird.deleteOrgTraces, { orgId });

  // 2. Delete Convex records in paginated batches to stay under mutation limits
  const convexDeleted = {
    apiKeys: 0,
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
    const batch = await ctx.runMutation(internal.admin.deleteOrgRecordsBatch, { orgId });
    for (const key of Object.keys(convexDeleted) as (keyof typeof convexDeleted)[]) {
      convexDeleted[key] += batch.counts[key];
    }
    hasMore = batch.hasMore;
  }

  // 3. Cancel Stripe subscription if active
  let stripeCanceled = false;
  const subscription = await ctx.runQuery(internal.subscriptions.getByOrgId, { orgId });
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
  await ctx.runMutation(internal.admin.finalizeOrgDeletion, { orgId });

  return { tinybirdResults, convexDeleted, stripeCanceled };
}

const deleteBatchCountsValidator = v.object({
  apiKeys: v.number(),
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
      return false;
    }

    // Delete API keys
    const apiKeys = await ctx.db
      .query('apiKeys')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .take(PAGE_SIZE);
    if (await deleteBatch(apiKeys, 'apiKeys')) return { counts, hasMore: true };

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
      .collect();
    for (const member of members) {
      if (ops >= PAGE_SIZE) return { counts, hasMore: true };

      if (member.status !== 'removed') {
        await ctx.db.patch(member._id, { status: 'removed', removedAt: Date.now() });
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

    return { counts, hasMore: false };
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
