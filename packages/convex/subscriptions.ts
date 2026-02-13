import {
  query,
  mutation,
  internalQuery,
  action,
  internalAction,
  internalMutation,
} from './_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from './auth';
import { getCurrentUser, requireEnabledUser } from './users';
import { internal } from './_generated/api';
import { TIER_CONFIG } from '@trace-flow/types';
import type { SubscriptionTier } from '@trace-flow/types';
import Stripe from 'stripe';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeProPriceId = process.env.STRIPE_PRICE_ID_PRO;
const stripeAddonPriceId = process.env.STRIPE_PRICE_ID_ADDON;
const appUrl = process.env.APP_URL ?? 'http://localhost:3000';

function getStripeClient() {
  if (!stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not set');
  }
  return new Stripe(stripeSecretKey);
}

function getProPriceId(): string {
  if (!stripeProPriceId) {
    throw new Error('STRIPE_PRICE_ID_PRO environment variable is not set');
  }
  return stripeProPriceId;
}

function getAddonPriceId(): string {
  if (!stripeAddonPriceId) {
    throw new Error('STRIPE_PRICE_ID_ADDON environment variable is not set');
  }
  return stripeAddonPriceId;
}

export function mapStripeStatusToInternal(
  status: string,
): 'active' | 'grace' | 'suspended' | 'canceled' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'grace';
    case 'incomplete':
    case 'unpaid':
      return 'suspended';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      throw new Error(`Unknown Stripe subscription status: ${status}`);
  }
}

async function requireOrgOwner(ctx: Parameters<typeof requireEnabledUser>[0]) {
  const user = await requireEnabledUser(ctx);
  if (!user.orgId) throw new Error('Organization not found');
  const org = await ctx.db.get(user.orgId);
  if (!org) throw new Error('Organization not found');
  if (org.ownerId !== user._id) {
    throw new Error('Only organization owners can manage billing');
  }
  return { user, org };
}

export const getForCurrentUser = query({
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) return null;

    return await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
      .first();
  },
});

export const getBillingSummaryForCurrentUser = query({
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) return null;

    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
      .first();

    if (!subscription) return null;

    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_id_status', (q) => q.eq('orgId', user.orgId!).eq('status', 'active'))
      .collect();

    const periodStart = subscription.currentPeriodStart ?? 0;
    const usage = await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', user.orgId!).eq('periodStart', periodStart),
      )
      .first();

    const totalUsed = (usage?.subscriptionUnitsUsed ?? 0) + (usage?.addonUnitsUsed ?? 0);
    const totalAvailable = subscription.monthlyUnits + subscription.addonUnits;

    return {
      subscription,
      activeMembers: members.length,
      seatsRemaining: Math.max(0, (subscription.seatQuantity ?? 1) - members.length),
      totalUsed,
      totalAvailable,
      remaining: Math.max(0, totalAvailable - totalUsed),
      currentPeriodEnd: subscription.currentPeriodEnd ?? 0,
    };
  },
});

export const setTier = internalMutation({
  args: {
    orgId: v.id('organizations'),
    tier: v.union(v.literal('hobby'), v.literal('pro')),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();

    if (!subscription) throw new Error('Subscription not found');

    const previousTier = subscription.tier;
    const config = TIER_CONFIG[args.tier as SubscriptionTier];
    await ctx.db.patch(subscription._id, {
      tier: args.tier,
      status: 'active',
      monthlyUnits: config.monthlyUnits,
      includedUnitsPerSeat: config.monthlyUnits,
    });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
      orgId: args.orgId,
      tier: args.tier,
      monthlyUnits: config.monthlyUnits,
      addonUnits: subscription.addonUnits,
      status: subscription.status ?? 'active',
      seatQuantity: subscription.seatQuantity ?? 1,
      currentPeriodStart: subscription.currentPeriodStart ?? 0,
      currentPeriodEnd: subscription.currentPeriodEnd ?? 0,
      autoOverage: subscription.autoOverage,
      overageCapCents: subscription.overageCapCents,
    });

    // When upgrading from hobby to pro, extend retention for existing traces
    if (previousTier === 'hobby' && args.tier === 'pro') {
      await ctx.scheduler.runAfter(0, internal.tinybird.extendRetention, {
        orgId: args.orgId,
      });
    }
  },
});

export const addAddonUnits = internalMutation({
  args: {
    orgId: v.id('organizations'),
    units: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.units <= 0) throw new Error('Units must be positive');

    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();

    if (!subscription) throw new Error('Subscription not found');

    const newAddonUnits = subscription.addonUnits + args.units;
    await ctx.db.patch(subscription._id, { addonUnits: newAddonUnits });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
      orgId: args.orgId,
      tier: subscription.tier,
      monthlyUnits: subscription.monthlyUnits,
      addonUnits: newAddonUnits,
      status: subscription.status ?? 'active',
      seatQuantity: subscription.seatQuantity ?? 1,
      currentPeriodStart: subscription.currentPeriodStart ?? 0,
      currentPeriodEnd: subscription.currentPeriodEnd ?? 0,
      autoOverage: subscription.autoOverage,
      overageCapCents: subscription.overageCapCents,
    });
  },
});

export const getByOrgId = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
  },
});

export const getByStripeSubscriptionId = internalQuery({
  args: { stripeSubscriptionId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('subscriptions')
      .withIndex('by_stripe_subscription_id', (q) =>
        q.eq('stripeSubscriptionId', args.stripeSubscriptionId),
      )
      .first();
  },
});

export const getByStripeCustomerId = internalQuery({
  args: { stripeCustomerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('subscriptions')
      .withIndex('by_stripe_customer_id', (q) => q.eq('stripeCustomerId', args.stripeCustomerId))
      .first();
  },
});

export const createOrgCheckoutSession = action({
  args: {
    successUrl: v.optional(v.string()),
    cancelUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    const user = await ctx.runQuery(internal.users.getUserByTokenIdentifier, {
      tokenIdentifier: (await ctx.auth.getUserIdentity())!.tokenIdentifier,
    });
    if (!user?.orgId) throw new Error('Organization not found');
    const org = await ctx.runQuery(internal.organizations.getByIdInternal, { id: user.orgId });
    if (!org) throw new Error('Organization not found');
    if (org.ownerId !== user._id) throw new Error('Only organization owners can manage billing');

    const subscription = await ctx.runQuery(internal.subscriptions.getByOrgId, {
      orgId: user.orgId,
    });
    if (subscription?.stripeSubscriptionId && subscription.tier === 'pro') {
      throw new Error(
        'Organization already has an active Pro subscription. Use the billing portal to manage it.',
      );
    }
    const seatQuantity = Math.max(1, subscription?.seatQuantity ?? 1);

    const stripe = getStripeClient();
    let stripeCustomerId = subscription?.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: org.name,
        metadata: {
          orgId: user.orgId,
          ownerUserId: user._id,
        },
      });
      stripeCustomerId = customer.id;
      if (subscription) {
        await ctx.runMutation(internal.subscriptions.setStripeCustomerId, {
          orgId: user.orgId,
          stripeCustomerId,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { name: 'auto', address: 'auto' },
      line_items: [{ price: getProPriceId(), quantity: seatQuantity }],
      client_reference_id: user.orgId,
      success_url: args.successUrl ?? `${appUrl}/app/settings/billing?checkout=success`,
      cancel_url: args.cancelUrl ?? `${appUrl}/app/settings/billing?checkout=cancel`,
      metadata: {
        orgId: user.orgId,
        ownerUserId: user._id,
      },
    });

    return { url: session.url };
  },
});

export const createAddonCheckoutSession = action({
  args: {
    units: v.number(),
    quantity: v.optional(v.number()),
    successUrl: v.optional(v.string()),
    cancelUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    if (args.units <= 0) throw new Error('units must be positive');
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Authentication required');
    const user = await ctx.runQuery(internal.users.getUserByTokenIdentifier, {
      tokenIdentifier: identity.tokenIdentifier,
    });
    if (!user?.orgId) throw new Error('Organization not found');
    const org = await ctx.runQuery(internal.organizations.getByIdInternal, { id: user.orgId });
    if (!org || org.ownerId !== user._id) {
      throw new Error('Only organization owners can manage billing');
    }

    const subscription = await ctx.runQuery(internal.subscriptions.getByOrgId, {
      orgId: user.orgId,
    });
    if (subscription?.tier !== 'pro') {
      throw new Error('Addons require a Pro subscription');
    }
    if (!subscription.stripeCustomerId) {
      throw new Error('Organization is missing Stripe customer');
    }

    const quantity = Math.max(1, args.quantity ?? 1);
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: subscription.stripeCustomerId,
      automatic_tax: { enabled: true },
      line_items: [{ price: getAddonPriceId(), quantity }],
      success_url: args.successUrl ?? `${appUrl}/app/settings/billing?addon=success`,
      cancel_url: args.cancelUrl ?? `${appUrl}/app/settings/billing?addon=cancel`,
      payment_intent_data: {
        metadata: {
          orgId: user.orgId,
          ownerUserId: user._id,
          addonUnits: String(args.units),
          mode: 'manual',
        },
      },
    });
    return { url: session.url };
  },
});

export const createBillingPortalSession = action({
  args: {
    returnUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Authentication required');
    const user = await ctx.runQuery(internal.users.getUserByTokenIdentifier, {
      tokenIdentifier: identity.tokenIdentifier,
    });
    if (!user?.orgId) throw new Error('Organization not found');
    const org = await ctx.runQuery(internal.organizations.getByIdInternal, { id: user.orgId });
    if (!org || org.ownerId !== user._id) {
      throw new Error('Only organization owners can manage billing');
    }

    const subscription = await ctx.runQuery(internal.subscriptions.getByOrgId, {
      orgId: user.orgId,
    });
    if (!subscription?.stripeCustomerId) {
      throw new Error('Organization is missing Stripe customer');
    }

    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: args.returnUrl ?? `${appUrl}/app/settings/billing`,
    });
    return { url: session.url };
  },
});

export const updateSeatQuantity = action({
  args: {
    seatQuantity: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    if (args.seatQuantity < 1) throw new Error('seatQuantity must be at least 1');
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Authentication required');
    const user = await ctx.runQuery(internal.users.getUserByTokenIdentifier, {
      tokenIdentifier: identity.tokenIdentifier,
    });
    if (!user?.orgId) throw new Error('Organization not found');
    const org = await ctx.runQuery(internal.organizations.getByIdInternal, { id: user.orgId });
    if (!org || org.ownerId !== user._id) {
      throw new Error('Only organization owners can manage billing');
    }

    const subscription = await ctx.runQuery(internal.subscriptions.getByOrgId, {
      orgId: user.orgId,
    });
    if (!subscription?.stripeSubscriptionId || !subscription.stripeSubscriptionItemId) {
      throw new Error('Stripe subscription is not configured');
    }

    const activeMembers = await ctx.runQuery(internal.organizations.getActiveMemberCountInternal, {
      orgId: user.orgId,
    });
    if (args.seatQuantity < activeMembers) {
      throw new Error(`Cannot reduce seats below active member count (${activeMembers})`);
    }

    const stripe = getStripeClient();
    const updated = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      items: [
        {
          id: subscription.stripeSubscriptionItemId,
          quantity: args.seatQuantity,
        },
      ],
    });
    const item = updated.items.data[0];

    await ctx.runMutation(internal.subscriptions.upsertStripeSubscriptionState, {
      orgId: user.orgId,
      status: mapStripeStatusToInternal(updated.status),
      stripeCustomerId:
        typeof updated.customer === 'string' ? updated.customer : updated.customer.id,
      stripeSubscriptionId: updated.id,
      stripeSubscriptionItemId: item?.id,
      seatQuantity: item?.quantity ?? args.seatQuantity,
      currentPeriodStart: (item?.current_period_start ?? 0) * 1000,
      currentPeriodEnd: (item?.current_period_end ?? 0) * 1000,
    });
  },
});

export const updateAutoOverageSettings = mutation({
  args: {
    autoOverage: v.boolean(),
    overageCapCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    const { user } = await requireOrgOwner(ctx);
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
      .first();
    if (!subscription) throw new Error('Subscription not found');
    if (subscription.tier !== 'pro') throw new Error('Auto-topup requires Pro');
    await ctx.db.patch(subscription._id, {
      autoOverage: args.autoOverage,
      overageCapCents: args.overageCapCents,
    });
    await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
      orgId: user.orgId!,
      tier: subscription.tier,
      monthlyUnits: subscription.monthlyUnits,
      addonUnits: subscription.addonUnits,
      status: subscription.status ?? 'active',
      seatQuantity: subscription.seatQuantity ?? 1,
      currentPeriodStart: subscription.currentPeriodStart ?? 0,
      currentPeriodEnd: subscription.currentPeriodEnd ?? 0,
      autoOverage: args.autoOverage,
      overageCapCents: args.overageCapCents,
    });
  },
});

export const triggerAutoTopup = internalAction({
  args: {
    orgId: v.id('organizations'),
    units: v.number(),
    amountCents: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.units <= 0 || args.amountCents <= 0) {
      throw new Error('units and amountCents must be positive');
    }
    const subscription = await ctx.runQuery(internal.subscriptions.getByOrgId, {
      orgId: args.orgId,
    });
    if (!subscription) throw new Error('Subscription not found');
    if (subscription.tier !== 'pro') throw new Error('Auto-topup requires Pro');
    if (!subscription.autoOverage) throw new Error('Auto-topup disabled');
    if (!subscription.stripeCustomerId) throw new Error('Missing stripe customer');

    // Pre-check cap to avoid charging then failing
    const cap = subscription.overageCapCents;
    const spent = subscription.currentPeriodOverageSpentCents ?? 0;
    if (cap !== undefined && spent + args.amountCents > cap) {
      return { ok: false, reason: 'cap_reached' as const };
    }

    const idempotencyKey = `auto-topup:${args.orgId}:${subscription.currentPeriodStart ?? 0}:${subscription.addonPurchaseCount ?? 0}`;
    const stripe = getStripeClient();
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: args.amountCents,
        currency: 'usd',
        customer: subscription.stripeCustomerId,
        confirm: true,
        off_session: true,
        metadata: {
          orgId: args.orgId,
          reason: args.reason ?? 'usage_threshold',
          mode: 'auto',
          addonUnits: String(args.units),
        },
      },
      { idempotencyKey },
    );
    if (paymentIntent.status !== 'succeeded') {
      throw new Error(`Auto-topup payment did not succeed (${paymentIntent.status})`);
    }

    try {
      await ctx.runMutation(internal.subscriptions.creditAddonPurchase, {
        orgId: args.orgId,
        units: args.units,
        amountCents: args.amountCents,
        stripePaymentIntentId: paymentIntent.id,
        mode: 'auto',
      });
    } catch (e) {
      await stripe.refunds.create({ payment_intent: paymentIntent.id });
      throw e;
    }

    return { ok: true, paymentIntentId: paymentIntent.id };
  },
});

export const reconcileCurrentOrgWithStripe = action({
  args: {},
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Authentication required');
    const user = await ctx.runQuery(internal.users.getUserByTokenIdentifier, {
      tokenIdentifier: identity.tokenIdentifier,
    });
    if (!user?.orgId) throw new Error('Organization not found');
    const org = await ctx.runQuery(internal.organizations.getByIdInternal, { id: user.orgId });
    if (!org || org.ownerId !== user._id) {
      throw new Error('Only organization owners can reconcile billing');
    }

    const subscription = await ctx.runQuery(internal.subscriptions.getByOrgId, {
      orgId: user.orgId,
    });
    if (!subscription?.stripeSubscriptionId) {
      return { reconciled: false, reason: 'missing_stripe_subscription' };
    }

    const stripe = getStripeClient();
    const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
    const item = stripeSub.items.data[0];

    await ctx.runMutation(internal.subscriptions.upsertStripeSubscriptionState, {
      orgId: user.orgId,
      status: mapStripeStatusToInternal(stripeSub.status),
      stripeCustomerId:
        typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id,
      stripeSubscriptionId: stripeSub.id,
      stripeSubscriptionItemId: item?.id,
      seatQuantity: item?.quantity ?? 1,
      currentPeriodStart: (item?.current_period_start ?? 0) * 1000,
      currentPeriodEnd: (item?.current_period_end ?? 0) * 1000,
    });

    return { reconciled: true };
  },
});

export const setStripeCustomerId = internalMutation({
  args: {
    orgId: v.id('organizations'),
    stripeCustomerId: v.string(),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) throw new Error('Subscription not found');
    await ctx.db.patch(subscription._id, {
      stripeCustomerId: args.stripeCustomerId,
    });
  },
});

export const upsertStripeSubscriptionState = internalMutation({
  args: {
    orgId: v.id('organizations'),
    status: v.union(
      v.literal('active'),
      v.literal('grace'),
      v.literal('suspended'),
      v.literal('canceled'),
    ),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripeSubscriptionItemId: v.optional(v.string()),
    seatQuantity: v.optional(v.number()),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) throw new Error('Subscription not found');

    const seatQuantity = args.seatQuantity ?? subscription.seatQuantity ?? 1;
    const includedUnitsPerSeat = subscription.includedUnitsPerSeat ?? subscription.monthlyUnits;
    const monthlyUnits = Math.max(0, seatQuantity * includedUnitsPerSeat);

    // Cancel grace period scheduler when transitioning to active
    if (args.status === 'active' && subscription.gracePeriodSchedulerId) {
      await ctx.scheduler.cancel(subscription.gracePeriodSchedulerId);
    }

    await ctx.db.patch(subscription._id, {
      status: args.status,
      stripeCustomerId: args.stripeCustomerId ?? subscription.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId ?? subscription.stripeSubscriptionId,
      stripeSubscriptionItemId:
        args.stripeSubscriptionItemId ?? subscription.stripeSubscriptionItemId,
      seatQuantity,
      includedUnitsPerSeat,
      monthlyUnits,
      currentPeriodStart: args.currentPeriodStart ?? subscription.currentPeriodStart,
      currentPeriodEnd: args.currentPeriodEnd ?? subscription.currentPeriodEnd,
      currentPeriodOverageSpentCents:
        args.currentPeriodStart && args.currentPeriodStart !== subscription.currentPeriodStart
          ? 0
          : subscription.currentPeriodOverageSpentCents,
      ...(args.status === 'active' ? { gracePeriodSchedulerId: undefined } : {}),
    });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
      orgId: args.orgId,
      tier: subscription.tier,
      monthlyUnits,
      addonUnits: subscription.addonUnits,
      status: args.status,
      seatQuantity,
      currentPeriodStart: args.currentPeriodStart ?? subscription.currentPeriodStart ?? 0,
      currentPeriodEnd: args.currentPeriodEnd ?? subscription.currentPeriodEnd ?? 0,
      autoOverage: subscription.autoOverage,
      overageCapCents: subscription.overageCapCents,
    });
  },
});

export const creditAddonPurchase = internalMutation({
  args: {
    orgId: v.id('organizations'),
    units: v.number(),
    amountCents: v.number(),
    stripePaymentIntentId: v.string(),
    mode: v.union(v.literal('manual'), v.literal('auto')),
    triggeredByUserId: v.optional(v.id('users')),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('addonPurchases')
      .withIndex('by_payment_intent', (q) =>
        q.eq('stripePaymentIntentId', args.stripePaymentIntentId),
      )
      .first();
    if (existing) return;

    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) throw new Error('Subscription not found');

    // Validate overage cap inside the transactional mutation to prevent races
    if (args.mode === 'auto') {
      const cap = subscription.overageCapCents;
      const spent = subscription.currentPeriodOverageSpentCents ?? 0;
      if (cap !== undefined && spent + args.amountCents > cap) {
        throw new Error('Overage cap reached');
      }
    }

    const newAddonUnits = subscription.addonUnits + args.units;
    const newOverageSpent =
      (subscription.currentPeriodOverageSpentCents ?? 0) +
      (args.mode === 'auto' ? args.amountCents : 0);
    await ctx.db.patch(subscription._id, {
      addonUnits: newAddonUnits,
      addonPurchaseCount: (subscription.addonPurchaseCount ?? 0) + 1,
      currentPeriodOverageSpentCents: newOverageSpent,
      autoTopupPendingSince: undefined,
    });
    await ctx.db.insert('addonPurchases', {
      orgId: args.orgId,
      triggeredByUserId: args.triggeredByUserId,
      units: args.units,
      amountCents: args.amountCents,
      stripePaymentIntentId: args.stripePaymentIntentId,
      mode: args.mode,
      periodStart: subscription.currentPeriodStart ?? 0,
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
      orgId: args.orgId,
      tier: subscription.tier,
      monthlyUnits: subscription.monthlyUnits,
      addonUnits: newAddonUnits,
      status: subscription.status ?? 'active',
      seatQuantity: subscription.seatQuantity ?? 1,
      currentPeriodStart: subscription.currentPeriodStart ?? 0,
      currentPeriodEnd: subscription.currentPeriodEnd ?? 0,
      autoOverage: subscription.autoOverage,
      overageCapCents: subscription.overageCapCents,
    });
  },
});

const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const scheduleGraceSuspension = internalMutation({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return;
    if (subscription.status !== 'grace') return;
    // Don't schedule if one is already pending
    if (subscription.gracePeriodSchedulerId) return;

    const schedulerId = await ctx.scheduler.runAfter(
      GRACE_PERIOD_MS,
      internal.subscriptions.transitionGraceToSuspended,
      { orgId: args.orgId },
    );
    await ctx.db.patch(subscription._id, {
      gracePeriodSchedulerId: schedulerId,
    });
  },
});

export const transitionGraceToSuspended = internalMutation({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return;
    if (subscription.status !== 'grace') return;

    await ctx.db.patch(subscription._id, {
      status: 'suspended',
      gracePeriodSchedulerId: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
      orgId: args.orgId,
      tier: subscription.tier,
      monthlyUnits: subscription.monthlyUnits,
      addonUnits: subscription.addonUnits,
      status: 'suspended',
      seatQuantity: subscription.seatQuantity ?? 1,
      currentPeriodStart: subscription.currentPeriodStart ?? 0,
      currentPeriodEnd: subscription.currentPeriodEnd ?? 0,
      autoOverage: subscription.autoOverage,
      overageCapCents: subscription.overageCapCents,
    });
  },
});
