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

  // 2. Delete Convex records in batches
  const convexDeleted = await ctx.runMutation(internal.admin.deleteOrgRecords, { orgId });

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

export const deleteOrgRecords = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.object({
    apiKeys: v.number(),
    usage: v.number(),
    addonPurchases: v.number(),
    membersRemoved: v.number(),
    invites: v.number(),
    alerts: v.number(),
    mcpSessions: v.number(),
    mcpRefreshTokens: v.number(),
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

    // Delete API keys
    const apiKeys = await ctx.db
      .query('apiKeys')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .collect();
    for (const key of apiKeys) {
      await ctx.db.delete(key._id);
      counts.apiKeys++;
    }

    // Delete usage records
    const usageRecords = await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) => q.eq('orgId', args.orgId))
      .collect();
    for (const record of usageRecords) {
      await ctx.db.delete(record._id);
      counts.usage++;
    }

    // Delete addon purchases
    const addons = await ctx.db
      .query('addonPurchases')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .collect();
    for (const addon of addons) {
      await ctx.db.delete(addon._id);
      counts.addonPurchases++;
    }

    // Mark members as removed and clean up per-member data
    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .collect();
    for (const member of members) {
      if (member.status !== 'removed') {
        await ctx.db.patch(member._id, { status: 'removed', removedAt: Date.now() });
        counts.membersRemoved++;
      }

      // Delete per-user data
      const alerts = await ctx.db
        .query('alerts')
        .withIndex('by_user_id', (q) => q.eq('userId', member.userId))
        .collect();
      for (const alert of alerts) {
        await ctx.db.delete(alert._id);
        counts.alerts++;
      }

      const sessions = await ctx.db
        .query('mcpSessions')
        .withIndex('by_user_id', (q) => q.eq('userId', member.userId))
        .collect();
      for (const session of sessions) {
        await ctx.db.delete(session._id);
        counts.mcpSessions++;
      }

      const tokens = await ctx.db
        .query('mcpRefreshTokens')
        .withIndex('by_user_id', (q) => q.eq('userId', member.userId))
        .collect();
      for (const token of tokens) {
        await ctx.db.delete(token._id);
        counts.mcpRefreshTokens++;
      }
    }

    // Delete invites
    const invites = await ctx.db
      .query('invites')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', args.orgId))
      .collect();
    for (const invite of invites) {
      await ctx.db.delete(invite._id);
      counts.invites++;
    }

    return counts;
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
      // Cancel any pending schedulers
      if (subscription.gracePeriodSchedulerId) {
        await ctx.scheduler.cancel(subscription.gracePeriodSchedulerId);
      }
      if (subscription.deletionSchedulerId) {
        await ctx.scheduler.cancel(subscription.deletionSchedulerId);
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
