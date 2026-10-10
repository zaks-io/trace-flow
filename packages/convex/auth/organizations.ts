import { query, mutation, internalQuery, internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import { requireAuthenticated } from './auth';
import {
  getActiveOrganizationMembership,
  getCurrentEnabledUser,
  isLiveOrganization,
  requireActiveOrganizationMembership,
  requireOrganizationOwner,
} from './userHelpers';
import { organizationValidator } from '../validators';
import { internal } from '../_generated/api';
import { TIER_CONFIG } from '@trace-flow/types';
import type { SubscriptionKVData } from '@trace-flow/types';
import type { Id } from '../_generated/dataModel';

export const completeOnboarding = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const { organization, orgId } = await requireActiveOrganizationMembership(ctx);
    if (organization.onboardingCompletedAt) return null;

    await ctx.db.patch(orgId, { onboardingCompletedAt: Date.now() });
    return null;
  },
});

export const get = query({
  args: {},
  returns: v.union(v.null(), organizationValidator),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const user = await getCurrentEnabledUser(ctx);
    const active = await getActiveOrganizationMembership(ctx, user);
    return active?.organization ?? null;
  },
});

export const getMembers = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('organizationMembers'),
      _creationTime: v.number(),
      orgId: v.id('organizations'),
      userId: v.id('users'),
      role: v.union(v.literal('owner'), v.literal('member')),
      status: v.union(v.literal('active'), v.literal('removed')),
      invitedAt: v.optional(v.number()),
      joinedAt: v.optional(v.number()),
      removedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requireAuthenticated(ctx);
    const user = await getCurrentEnabledUser(ctx);
    const active = await getActiveOrganizationMembership(ctx, user);
    if (!active) return [];
    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id', (q) => q.eq('orgId', active.orgId))
      .collect();
    return members.map((member) => ({
      ...member,
      role:
        member.userId === active.organization.ownerId ? ('owner' as const) : ('member' as const),
    }));
  },
});

export const rename = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAuthenticated(ctx);
    const { orgId } = await requireOrganizationOwner(ctx);
    await ctx.db.patch(orgId, { name: args.name });
    return null;
  },
});

export const getByIdInternal = internalQuery({
  args: { id: v.id('organizations') },
  returns: v.union(v.null(), organizationValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const setStripeCustomerId = internalMutation({
  args: {
    orgId: v.id('organizations'),
    stripeCustomerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.auth.getUserIdentity()) await requireOrganizationOwner(ctx, args.orgId);
    const org = await ctx.db.get(args.orgId);
    if (!org) throw new Error('Organization not found');
    await ctx.db.patch(args.orgId, { stripeCustomerId: args.stripeCustomerId });
    return null;
  },
});

export const getByStripeCustomerId = internalQuery({
  args: { stripeCustomerId: v.string() },
  returns: v.union(v.null(), organizationValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('organizations')
      .withIndex('by_stripe_customer_id', (q) => q.eq('stripeCustomerId', args.stripeCustomerId))
      .first();
  },
});

async function insertHobbySubscription(ctx: MutationCtx, orgId: Id<'organizations'>) {
  const now = Date.now();
  const periodEnd = now + 30 * 24 * 60 * 60 * 1000;
  const kvData: Required<SubscriptionKVData> = {
    tier: 'hobby',
    status: 'active',
    monthlyUnits: TIER_CONFIG.hobby.monthlyUnits,
    addonUnits: 0,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    autoOverage: false,
    overageCapCents: 0,
    cancelAtPeriodEnd: false,
  };

  await ctx.db.insert('subscriptions', {
    orgId,
    ...kvData,
    currentPeriodOverageSpentCents: 0,
    addonPurchaseCount: 0,
  });

  await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncSubscriptionToKV, {
    orgId,
    ...kvData,
  });
}

/**
 * Canonical org bootstrap: creates org, owner membership, and default hobby subscription.
 * Call this from user bootstrap flows instead of creating orgs directly.
 * No Stripe customer is created for hobby tier.
 */
export async function createOrgWithDefaultBilling(
  ctx: MutationCtx,
  userId: Id<'users'>,
  name?: string,
): Promise<Id<'organizations'>> {
  const orgName = name ? `${name}'s Org` : 'My Organization';
  const orgId = await ctx.db.insert('organizations', {
    name: orgName,
    ownerId: userId,
  });
  await ctx.db.patch(userId, { orgId });
  await ctx.db.insert('organizationMembers', {
    orgId,
    userId,
    role: 'owner',
    status: 'active',
    joinedAt: Date.now(),
  });

  await insertHobbySubscription(ctx, orgId);

  return orgId;
}

/**
 * Ensures an existing org has a hobby subscription. Idempotent: no-op if one exists.
 * Used when a user joins an org via invite and the org lacks billing (e.g. migrated data).
 */
export async function ensureOrgHasSubscription(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
): Promise<void> {
  const organization = await ctx.db.get(orgId);
  if (!isLiveOrganization(organization)) {
    throw new Error('Organization is not active');
  }
  const existing = await ctx.db
    .query('subscriptions')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .first();
  if (existing) return;

  await insertHobbySubscription(ctx, orgId);
}
