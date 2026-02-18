import {
  query,
  mutation,
  internalQuery,
  action,
  internalAction,
  internalMutation,
} from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from './auth';
import { getCurrentUser, requireEnabledUser } from './users';
import { internal } from './_generated/api';
import { TIER_CONFIG } from '@trace-flow/types';
import type { SubscriptionTier } from '@trace-flow/types';
import type { Id } from './_generated/dataModel';
import Stripe from 'stripe';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeProPriceId = process.env.STRIPE_PRICE_ID_PRO;
const stripeSeatPriceId = process.env.STRIPE_PRICE_ID_SEAT;
const stripeAddonPriceId = process.env.STRIPE_PRICE_ID_ADDON;
const appUrl = process.env.APP_URL ?? 'http://localhost:3000';

const STRIPE_API_VERSION = '2026-01-28.clover';

function getStripeClient() {
  if (!stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not set');
  }
  return new Stripe(stripeSecretKey, { apiVersion: STRIPE_API_VERSION });
}

function getProPriceId(): string {
  if (!stripeProPriceId) {
    throw new Error('STRIPE_PRICE_ID_PRO environment variable is not set');
  }
  return stripeProPriceId;
}

function getSeatPriceId(): string {
  if (!stripeSeatPriceId) {
    throw new Error('STRIPE_PRICE_ID_SEAT environment variable is not set');
  }
  return stripeSeatPriceId;
}

function getAddonPriceId(): string {
  if (!stripeAddonPriceId) {
    throw new Error('STRIPE_PRICE_ID_ADDON environment variable is not set');
  }
  return stripeAddonPriceId;
}

/**
 * Matches subscription items to plan vs seat by their price ID.
 * Stripe subscriptions have two items: one for the base plan (quantity 1)
 * and one for per-seat billing (quantity = seat count).
 */
export function findSubscriptionItems(items: Stripe.SubscriptionItem[]): {
  planItem?: Stripe.SubscriptionItem;
  seatItem?: Stripe.SubscriptionItem;
} {
  const proPriceId = stripeProPriceId;
  const seatPriceId = stripeSeatPriceId;
  let planItem: Stripe.SubscriptionItem | undefined;
  let seatItem: Stripe.SubscriptionItem | undefined;

  for (const item of items) {
    const priceId = typeof item.price === 'string' ? item.price : item.price?.id;
    if (priceId === proPriceId) planItem = item;
    else if (priceId === seatPriceId) seatItem = item;
  }

  // If only one item and no match by price ID, treat it as the plan item (legacy)
  if (!planItem && !seatItem && items.length === 1) {
    planItem = items[0];
  }

  return { planItem, seatItem };
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

export async function scheduleKVSync(ctx: MutationCtx, subscriptionId: Id<'subscriptions'>) {
  const sub = await ctx.db.get(subscriptionId);
  if (!sub) return;
  await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
    orgId: sub.orgId,
    tier: sub.tier,
    monthlyUnits: sub.monthlyUnits,
    addonUnits: sub.addonUnits,
    status: sub.status,
    seatQuantity: sub.seatQuantity,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    autoOverage: sub.autoOverage,
    overageCapCents: sub.overageCapCents,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  });
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

    const usage = await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', user.orgId!).eq('periodStart', subscription.currentPeriodStart),
      )
      .first();

    const totalUsed = (usage?.subscriptionUnitsUsed ?? 0) + (usage?.addonUnitsUsed ?? 0);
    const totalAvailable = subscription.monthlyUnits + subscription.addonUnits;

    return {
      subscription,
      activeMembers: members.length,
      seatsRemaining: Math.max(0, subscription.seatQuantity - members.length),
      totalUsed,
      totalAvailable,
      remaining: Math.max(0, totalAvailable - totalUsed),
      currentPeriodEnd: subscription.currentPeriodEnd,
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
    });

    await scheduleKVSync(ctx, subscription._id);

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

    await scheduleKVSync(ctx, subscription._id);
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
    if (
      subscription?.stripeSubscriptionId &&
      (subscription.status === 'active' || subscription.status === 'grace')
    ) {
      throw new Error(
        'Organization already has an active subscription. Use the billing portal to manage it.',
      );
    }
    const seatQuantity = Math.max(1, subscription?.seatQuantity ?? 1);

    const stripe = getStripeClient();
    let stripeCustomerId = org.stripeCustomerId ?? subscription?.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create(
        {
          email: user.email,
          name: org.name,
          metadata: {
            orgId: user.orgId,
            ownerUserId: user._id,
          },
        },
        { idempotencyKey: `cust-create:${user.orgId}` },
      );
      stripeCustomerId = customer.id;
    }
    // Write to both org and subscription tables during transition
    await ctx.runMutation(internal.organizations.setStripeCustomerId, {
      orgId: user.orgId,
      stripeCustomerId,
    });
    await ctx.runMutation(internal.subscriptions.setStripeCustomerId, {
      orgId: user.orgId,
      stripeCustomerId,
    });

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: stripeCustomerId,
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        customer_update: { name: 'auto', address: 'auto' },
        line_items: [
          { price: getProPriceId(), quantity: 1 },
          { price: getSeatPriceId(), quantity: seatQuantity },
        ],
        client_reference_id: user.orgId,
        success_url: args.successUrl ?? `${appUrl}/app/settings/billing?checkout=success`,
        cancel_url: args.cancelUrl ?? `${appUrl}/app/settings/billing?checkout=cancel`,
        metadata: {
          orgId: user.orgId,
          ownerUserId: user._id,
        },
        subscription_data: {
          metadata: {
            orgId: user.orgId,
          },
        },
      },
      { idempotencyKey: `checkout-sub:${user.orgId}:${Math.floor(Date.now() / 60000)}` },
    );

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
    const stripeCustomerId = org.stripeCustomerId ?? subscription.stripeCustomerId;
    if (!stripeCustomerId) {
      throw new Error('Organization is missing Stripe customer');
    }

    const quantity = Math.max(1, args.quantity ?? 1);
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer: stripeCustomerId,
        automatic_tax: { enabled: true },
        line_items: [{ price: getAddonPriceId(), quantity }],
        success_url: args.successUrl ?? `${appUrl}/app/settings/billing?addon=success`,
        cancel_url: args.cancelUrl ?? `${appUrl}/app/settings/billing?addon=cancel`,
        invoice_creation: {
          enabled: true,
          invoice_data: {
            metadata: {
              orgId: user.orgId,
              ownerUserId: user._id,
              addonUnits: String(args.units),
              mode: 'manual',
            },
          },
        },
      },
      { idempotencyKey: `checkout-addon:${user.orgId}:${Math.floor(Date.now() / 60000)}` },
    );
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
    const stripeCustomerId = org.stripeCustomerId ?? subscription?.stripeCustomerId;
    if (!stripeCustomerId) {
      throw new Error('Organization is missing Stripe customer');
    }

    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
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
    if (!subscription?.stripeSubscriptionId || !subscription.stripeSeatItemId) {
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
          id: subscription.stripeSeatItemId,
          quantity: args.seatQuantity,
        },
      ],
    });
    const { planItem, seatItem } = findSubscriptionItems(updated.items.data);
    const periodItem = seatItem ?? planItem;

    await ctx.runMutation(internal.subscriptions.upsertStripeSubscriptionState, {
      orgId: user.orgId,
      status: mapStripeStatusToInternal(updated.status),
      stripeCustomerId:
        typeof updated.customer === 'string' ? updated.customer : updated.customer.id,
      stripeSubscriptionId: updated.id,
      stripePlanItemId: planItem?.id,
      stripeSeatItemId: seatItem?.id,
      seatQuantity: seatItem?.quantity ?? args.seatQuantity,
      currentPeriodStart: (periodItem?.current_period_start ?? 0) * 1000,
      currentPeriodEnd: (periodItem?.current_period_end ?? 0) * 1000,
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
    await scheduleKVSync(ctx, subscription._id);
  },
});

/**
 * Atomically reserves overage spend before charging Stripe.
 * Prevents cap overruns from concurrent topups by reserving the amount
 * inside a serialized mutation, so only one topup can claim remaining cap.
 */
export const reserveAutoTopup = internalMutation({
  args: {
    orgId: v.id('organizations'),
    amountCents: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; idempotencyKey: string } | { ok: false; reason: string }> => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return { ok: false, reason: 'subscription_not_found' };
    if (subscription.tier !== 'pro') return { ok: false, reason: 'not_pro' };
    if (!subscription.autoOverage) return { ok: false, reason: 'auto_topup_disabled' };

    const cap = subscription.overageCapCents;
    if (cap !== undefined && subscription.currentPeriodOverageSpentCents + args.amountCents > cap) {
      return { ok: false, reason: 'cap_reached' };
    }

    // Reserve the spend atomically
    await ctx.db.patch(subscription._id, {
      currentPeriodOverageSpentCents:
        subscription.currentPeriodOverageSpentCents + args.amountCents,
    });

    const idempotencyKey = `auto-topup:${args.orgId}:${subscription.currentPeriodStart}:${subscription.addonPurchaseCount}`;
    return { ok: true, idempotencyKey };
  },
});

export const releaseAutoTopupReservation = internalMutation({
  args: {
    orgId: v.id('organizations'),
    amountCents: v.number(),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return;

    await ctx.db.patch(subscription._id, {
      currentPeriodOverageSpentCents: Math.max(
        0,
        subscription.currentPeriodOverageSpentCents - args.amountCents,
      ),
      autoTopupPendingSince: undefined,
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

    const org = await ctx.runQuery(internal.organizations.getByIdInternal, { id: args.orgId });
    const subscription = await ctx.runQuery(internal.subscriptions.getByOrgId, {
      orgId: args.orgId,
    });
    const stripeCustomerId = org?.stripeCustomerId ?? subscription?.stripeCustomerId;
    if (!stripeCustomerId) throw new Error('Missing stripe customer');

    // Atomically reserve the overage spend before charging Stripe
    const reservation = await ctx.runMutation(internal.subscriptions.reserveAutoTopup, {
      orgId: args.orgId,
      amountCents: args.amountCents,
    });
    if (!reservation.ok) {
      return { ok: false, reason: reservation.reason };
    }

    const stripe = getStripeClient();
    let invoiceItem: Stripe.InvoiceItem;
    let invoice: Stripe.Invoice;

    try {
      invoiceItem = await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        amount: args.amountCents,
        currency: 'usd',
        description: `Auto top-up: ${args.units.toLocaleString()} units`,
      });

      invoice = await stripe.invoices.create(
        {
          customer: stripeCustomerId,
          auto_advance: true,
          metadata: {
            orgId: args.orgId,
            reason: args.reason ?? 'usage_threshold',
            mode: 'auto',
            addonUnits: String(args.units),
            invoiceItemId: invoiceItem.id,
          },
        },
        { idempotencyKey: reservation.idempotencyKey },
      );

      const paid = await stripe.invoices.pay(invoice.id);
      if (paid.status !== 'paid') {
        throw new Error(`Auto-topup invoice payment did not succeed (${paid.status})`);
      }
    } catch (e) {
      // Stripe charge failed — release the reservation
      await ctx.runMutation(internal.subscriptions.releaseAutoTopupReservation, {
        orgId: args.orgId,
        amountCents: args.amountCents,
      });
      throw e;
    }

    // In Stripe v20+, payment_intent is on the invoice payments, not top-level
    const invoicePayments = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 1 });
    const payment = invoicePayments.data[0]?.payment;
    const paymentIntentId =
      payment?.type === 'payment_intent'
        ? typeof payment.payment_intent === 'string'
          ? payment.payment_intent
          : payment.payment_intent?.id
        : undefined;
    if (!paymentIntentId) {
      throw new Error('Auto-topup invoice missing payment_intent');
    }

    await ctx.runMutation(internal.subscriptions.creditAddonPurchase, {
      orgId: args.orgId,
      units: args.units,
      amountCents: args.amountCents,
      stripePaymentIntentId: paymentIntentId,
      stripeInvoiceId: invoice.id,
      mode: 'auto',
    });

    return { ok: true, invoiceId: invoice.id };
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
    const { planItem, seatItem } = findSubscriptionItems(stripeSub.items.data);
    const periodItem = seatItem ?? planItem;

    await ctx.runMutation(internal.subscriptions.upsertStripeSubscriptionState, {
      orgId: user.orgId,
      status: mapStripeStatusToInternal(stripeSub.status),
      stripeCustomerId:
        typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id,
      stripeSubscriptionId: stripeSub.id,
      stripePlanItemId: planItem?.id,
      stripeSeatItemId: seatItem?.id,
      seatQuantity: seatItem?.quantity ?? 1,
      currentPeriodStart: (periodItem?.current_period_start ?? 0) * 1000,
      currentPeriodEnd: (periodItem?.current_period_end ?? 0) * 1000,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
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
    stripePlanItemId: v.optional(v.string()),
    stripeSeatItemId: v.optional(v.string()),
    seatQuantity: v.optional(v.number()),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) throw new Error('Subscription not found');

    const seatQuantity = args.seatQuantity ?? subscription.seatQuantity;

    // Cancel grace period scheduler when transitioning to active
    if (args.status === 'active' && subscription.gracePeriodSchedulerId) {
      await ctx.scheduler.cancel(subscription.gracePeriodSchedulerId);
    }

    await ctx.db.patch(subscription._id, {
      status: args.status,
      stripeCustomerId: args.stripeCustomerId ?? subscription.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId ?? subscription.stripeSubscriptionId,
      stripePlanItemId: args.stripePlanItemId ?? subscription.stripePlanItemId,
      stripeSeatItemId: args.stripeSeatItemId ?? subscription.stripeSeatItemId,
      seatQuantity,
      currentPeriodStart: args.currentPeriodStart ?? subscription.currentPeriodStart,
      currentPeriodEnd: args.currentPeriodEnd ?? subscription.currentPeriodEnd,
      currentPeriodOverageSpentCents:
        args.currentPeriodStart && args.currentPeriodStart !== subscription.currentPeriodStart
          ? 0
          : subscription.currentPeriodOverageSpentCents,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      ...(args.status === 'active' ? { gracePeriodSchedulerId: undefined } : {}),
    });

    await scheduleKVSync(ctx, subscription._id);
  },
});

export const creditAddonPurchase = internalMutation({
  args: {
    orgId: v.id('organizations'),
    units: v.number(),
    amountCents: v.number(),
    stripePaymentIntentId: v.string(),
    stripeInvoiceId: v.optional(v.string()),
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

    // For auto mode, reserveAutoTopup already checked the cap and reserved the spend.
    // For manual mode, no cap applies.
    const newAddonUnits = subscription.addonUnits + args.units;
    await ctx.db.patch(subscription._id, {
      addonUnits: newAddonUnits,
      addonPurchaseCount: subscription.addonPurchaseCount + 1,
      autoTopupPendingSince: undefined,
    });
    await ctx.db.insert('addonPurchases', {
      orgId: args.orgId,
      triggeredByUserId: args.triggeredByUserId,
      units: args.units,
      amountCents: args.amountCents,
      stripePaymentIntentId: args.stripePaymentIntentId,
      stripeInvoiceId: args.stripeInvoiceId,
      mode: args.mode,
      periodStart: subscription.currentPeriodStart,
    });

    await scheduleKVSync(ctx, subscription._id);
  },
});

export const revokeAddonPurchase = internalMutation({
  args: { stripePaymentIntentId: v.string() },
  handler: async (ctx, args) => {
    const purchase = await ctx.db
      .query('addonPurchases')
      .withIndex('by_payment_intent', (q) =>
        q.eq('stripePaymentIntentId', args.stripePaymentIntentId),
      )
      .first();
    if (!purchase) return;

    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', purchase.orgId))
      .first();
    if (!subscription) return;

    const newAddonUnits = Math.max(0, subscription.addonUnits - purchase.units);
    await ctx.db.patch(subscription._id, { addonUnits: newAddonUnits });
    await scheduleKVSync(ctx, subscription._id);
  },
});

export const revertToHobby = internalMutation({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return;

    // Cancel any pending grace->suspended scheduler before clearing the ID
    if (subscription.gracePeriodSchedulerId) {
      await ctx.scheduler.cancel(subscription.gracePeriodSchedulerId);
    }

    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const hobbyConfig = TIER_CONFIG.hobby;

    await ctx.db.patch(subscription._id, {
      tier: 'hobby',
      status: 'active',
      monthlyUnits: hobbyConfig.monthlyUnits,
      addonUnits: 0,
      currentPeriodOverageSpentCents: 0,
      autoOverage: undefined,
      overageCapCents: undefined,
      currentPeriodStart: now,
      currentPeriodEnd: now + thirtyDaysMs,
      stripeSubscriptionId: undefined,
      stripePlanItemId: undefined,
      stripeSeatItemId: undefined,
      cancelAtPeriodEnd: undefined,
      gracePeriodSchedulerId: undefined,
    });

    await scheduleKVSync(ctx, subscription._id);
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

    await scheduleKVSync(ctx, subscription._id);
  },
});
