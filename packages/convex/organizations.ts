import { query, mutation, internalQuery, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from './auth';
import { getCurrentUser, requireEnabledUser } from './users';

export const get = query({
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) return null;
    return await ctx.db.get(user.orgId);
  },
});

export const getMembers = query({
  args: {},
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) return [];
    return await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
      .collect();
  },
});

export const rename = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    const user = await requireEnabledUser(ctx);
    if (!user.orgId) throw new Error('No organization found');

    const org = await ctx.db.get(user.orgId);
    if (!org) throw new Error('Organization not found');
    if (org.ownerId !== user._id) throw new Error('Only the owner can rename the organization');

    await ctx.db.patch(user.orgId, { name: args.name });
  },
});

export const getByIdInternal = internalQuery({
  args: { id: v.id('organizations') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getActiveMemberCountInternal = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', args.orgId).eq('status', 'active'))
      .collect();
    return members.length;
  },
});

export const canAddMember = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return false;

    const activeMembers = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', args.orgId).eq('status', 'active'))
      .collect();

    return subscription.seatQuantity > activeMembers.length;
  },
});

export const setStripeCustomerId = internalMutation({
  args: {
    orgId: v.id('organizations'),
    stripeCustomerId: v.string(),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) throw new Error('Organization not found');
    await ctx.db.patch(args.orgId, { stripeCustomerId: args.stripeCustomerId });
  },
});

export const getByStripeCustomerId = internalQuery({
  args: { stripeCustomerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('organizations')
      .withIndex('by_stripe_customer_id', (q) => q.eq('stripeCustomerId', args.stripeCustomerId))
      .first();
  },
});
