import {
  query,
  mutation,
  internalQuery,
  action,
  internalAction,
  internalMutation,
} from '../_generated/server';
import type { MutationCtx, ActionCtx } from '../_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from '../auth/auth';
import { getCurrentUser, requireEnabledUser } from '../auth/userHelpers';
import { internal } from '../_generated/api';
import { TIER_CONFIG, UNITS_PER_ADDON } from '@trace-flow/types';
import type { SubscriptionTier } from '@trace-flow/types';
import type { Id } from '../_generated/dataModel';
import { getStripeClient, getProPriceId, getAddonPriceId, appUrl } from './stripe';
import { subscriptionValidator } from '../validators';

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

async function requireOrgOwnerAction(ctx: ActionCtx) {
  await requireTraceFlowRole(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Authentication required');
  const user = await ctx.runQuery(internal.auth.users.getUserByTokenIdentifier, {
    tokenIdentifier: identity.tokenIdentifier,
  });
  if (!user?.orgId) throw new Error('Organization not found');
  const orgId = user.orgId;
  const org = await ctx.runQuery(internal.auth.organizations.getByIdInternal, { id: orgId });
  if (!org) throw new Error('Organization not found');
  if (org.ownerId !== user._id) {
    throw new Error('Only organization owners can manage billing');
  }
  const subscription = await ctx.runQuery(internal.billing.subscriptions.getByOrgId, { orgId });
  return { user: { ...user, orgId }, org, subscription };
}

export async function scheduleKVSync(ctx: MutationCtx, subscriptionId: Id<'subscriptions'>) {
  const sub = await ctx.db.get(subscriptionId);
  if (!sub) return;
  await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncSubscriptionToKV, {
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
}

export const getForCurrentUser = query({
  args: {},
  returns: v.union(v.null(), subscriptionValidator),
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
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      subscription: subscriptionValidator,
      totalUsed: v.number(),
      totalAvailable: v.number(),
      remaining: v.number(),
      currentPeriodEnd: v.number(),
      role: v.union(v.literal('owner'), v.literal('member')),
    }),
  ),
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) return null;

    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
      .first();

    if (!subscription) return null;

    const usage = await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', user.orgId!).eq('periodStart', subscription.currentPeriodStart),
      )
      .first();

    const totalUsed = (usage?.subscriptionUnitsUsed ?? 0) + (usage?.addonUnitsUsed ?? 0);
    const totalAvailable = subscription.monthlyUnits + subscription.addonUnits;

    const membership = await ctx.db
      .query('organizationMembers')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .filter((q) => q.eq(q.field('orgId'), user.orgId!))
      .first();

    return {
      subscription,
      totalUsed,
      totalAvailable,
      remaining: Math.max(0, totalAvailable - totalUsed),
      currentPeriodEnd: subscription.currentPeriodEnd,
      role: membership?.role ?? 'member',
    };
  },
});

export const setTier = internalMutation({
  args: {
    orgId: v.id('organizations'),
    tier: v.union(v.literal('hobby'), v.literal('pro')),
  },
  returns: v.null(),
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
      await ctx.scheduler.runAfter(0, internal.integrations.tinybird.extendRetention, {
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
  returns: v.null(),
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
  returns: v.union(v.null(), subscriptionValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
  },
});

export const getByStripeSubscriptionId = internalQuery({
  args: { stripeSubscriptionId: v.string() },
  returns: v.union(v.null(), subscriptionValidator),
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
  returns: v.union(v.null(), subscriptionValidator),
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
  returns: v.object({ url: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const { user, org, subscription } = await requireOrgOwnerAction(ctx);
    if (
      subscription?.stripeSubscriptionId &&
      (subscription.status === 'active' || subscription.status === 'grace')
    ) {
      throw new Error(
        'Organization already has an active subscription. Use the billing portal to manage it.',
      );
    }
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
    // Dual-write: org table is the primary read path, subscription table
    // is kept in sync for webhook lookups via resolveOrgSubscription
    await ctx.runMutation(internal.auth.organizations.setStripeCustomerId, {
      orgId: user.orgId,
      stripeCustomerId,
    });
    await ctx.runMutation(internal.billing.subscriptions.setStripeCustomerId, {
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
        line_items: [{ price: getProPriceId(), quantity: 1 }],
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
      {
        idempotencyKey: `checkout-sub:${user.orgId}:${Math.floor(Date.now() / 60000)}`,
      },
    );

    return { url: session.url };
  },
});

export const createAddonCheckoutSession = action({
  args: {
    quantity: v.number(),
    successUrl: v.optional(v.string()),
    cancelUrl: v.optional(v.string()),
  },
  returns: v.object({ url: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const { user, org, subscription } = await requireOrgOwnerAction(ctx);
    const quantity = Math.max(1, Math.floor(args.quantity));
    const units = quantity * UNITS_PER_ADDON;
    if (subscription?.tier !== 'pro') {
      throw new Error('Addons require a Pro subscription');
    }
    const stripeCustomerId = org.stripeCustomerId ?? subscription?.stripeCustomerId;
    if (!stripeCustomerId) {
      throw new Error('Organization is missing Stripe customer');
    }

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
              addonUnits: String(units),
              mode: 'manual',
            },
          },
        },
      },
      {
        idempotencyKey: `checkout-addon:${user.orgId}:${quantity}:${Math.floor(Date.now() / 60000)}`,
      },
    );
    return { url: session.url };
  },
});

export const createBillingPortalSession = action({
  args: {
    returnUrl: v.optional(v.string()),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    const { org, subscription } = await requireOrgOwnerAction(ctx);
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

export const updateAutoOverageSettings = mutation({
  args: {
    autoOverage: v.boolean(),
    overageCapCents: v.optional(v.number()),
  },
  returns: v.null(),
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
  returns: v.union(
    v.object({ ok: v.literal(true), idempotencyKey: v.string() }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
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
  returns: v.null(),
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
    quantity: v.optional(v.number()),
    amountCents: v.number(),
    reason: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({ ok: v.literal(true), invoiceId: v.string() }),
  ),
  handler: async (ctx, args) => {
    const quantity = Math.max(1, Math.floor(args.quantity ?? 1));
    const units = quantity * UNITS_PER_ADDON;
    if (args.amountCents <= 0) {
      throw new Error('amountCents must be positive');
    }

    const org = await ctx.runQuery(internal.auth.organizations.getByIdInternal, { id: args.orgId });
    const subscription = await ctx.runQuery(internal.billing.subscriptions.getByOrgId, {
      orgId: args.orgId,
    });
    const stripeCustomerId = org?.stripeCustomerId ?? subscription?.stripeCustomerId;
    if (!stripeCustomerId) throw new Error('Missing stripe customer');

    // Atomically reserve the overage spend before charging Stripe
    const reservation = await ctx.runMutation(internal.billing.subscriptions.reserveAutoTopup, {
      orgId: args.orgId,
      amountCents: args.amountCents,
    });
    if (!reservation.ok) {
      return { ok: false as const, reason: reservation.reason };
    }

    const stripe = getStripeClient();
    let invoiceId: string;
    // Track whether payment succeeded so we know if the reservation
    // can safely be released on error. Once payment goes through, the
    // invoice.paid webhook owns crediting and the reservation must stay.
    let paymentSucceeded = false;

    try {
      const invoiceItem = await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        amount: args.amountCents,
        currency: 'usd',
        description: `Auto top-up: ${units.toLocaleString()} units`,
      });

      try {
        const invoice = await stripe.invoices.create(
          {
            customer: stripeCustomerId,
            auto_advance: true,
            metadata: {
              orgId: args.orgId,
              reason: args.reason ?? 'usage_threshold',
              mode: 'auto',
              addonUnits: String(units),
              invoiceItemId: invoiceItem.id,
            },
          },
          { idempotencyKey: reservation.idempotencyKey },
        );

        const paid = await stripe.invoices.pay(invoice.id);
        if (paid.status !== 'paid') {
          throw new Error(`Auto-topup invoice payment did not succeed (${paid.status})`);
        }

        paymentSucceeded = true;
        invoiceId = invoice.id;
      } catch (e) {
        // Clean up orphaned invoice item to prevent it attaching to
        // the next subscription renewal and silently overcharging
        try {
          await stripe.invoiceItems.del(invoiceItem.id);
        } catch (cleanupErr) {
          console.error('Failed to clean up orphaned invoice item', {
            invoiceItemId: invoiceItem.id,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
        throw e;
      }
    } catch (e) {
      if (!paymentSucceeded) {
        // Pre-payment failure (invoice creation or charge declined).
        // No money moved, so release the reservation.
        await ctx.runMutation(internal.billing.subscriptions.releaseAutoTopupReservation, {
          orgId: args.orgId,
          amountCents: args.amountCents,
        });
      }
      // Post-payment failures: money moved, invoice.paid webhook will
      // credit units via creditAddonPurchase. Do NOT release the
      // reservation — the spend tracking must stay accurate.
      throw e;
    }

    // Let the invoice.paid webhook handle creditAddonPurchase.
    // The reservation holds currentPeriodOverageSpentCents in place,
    // and creditAddonPurchase (called by the webhook) adds the addon
    // units idempotently via stripePaymentIntentId deduplication.
    return { ok: true as const, invoiceId };
  },
});

export const reconcileCurrentOrgWithStripe = action({
  args: {},
  returns: v.union(
    v.object({ reconciled: v.literal(false), reason: v.string() }),
    v.object({ reconciled: v.literal(true) }),
  ),
  handler: async (ctx) => {
    const { user, subscription } = await requireOrgOwnerAction(ctx);
    if (!subscription?.stripeSubscriptionId) {
      return { reconciled: false as const, reason: 'missing_stripe_subscription' };
    }

    const stripe = getStripeClient();
    const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
    const planItem = stripeSub.items.data[0];

    await ctx.runMutation(internal.billing.subscriptions.upsertStripeSubscriptionState, {
      orgId: user.orgId,
      status: mapStripeStatusToInternal(stripeSub.status),
      stripeCustomerId:
        typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id,
      stripeSubscriptionId: stripeSub.id,
      stripePlanItemId: planItem?.id,
      currentPeriodStart: (planItem?.current_period_start ?? 0) * 1000,
      currentPeriodEnd: (planItem?.current_period_end ?? 0) * 1000,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    });

    return { reconciled: true as const };
  },
});

export const setStripeCustomerId = internalMutation({
  args: {
    orgId: v.id('organizations'),
    stripeCustomerId: v.string(),
  },
  returns: v.null(),
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
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) throw new Error('Subscription not found');

    // Cancel grace period scheduler when transitioning to active (try/catch: job may have already fired)
    if (args.status === 'active' && subscription.gracePeriodSchedulerId) {
      try {
        await ctx.scheduler.cancel(subscription.gracePeriodSchedulerId);
      } catch {
        // Already completed or canceled
      }
    }

    // Cancel pending deletion if reactivating (try/catch: job may have already fired)
    if (args.status === 'active' && subscription.deletionSchedulerId) {
      try {
        await ctx.scheduler.cancel(subscription.deletionSchedulerId);
      } catch {
        // Already completed or canceled — safe to ignore
      }
    }

    await ctx.db.patch(subscription._id, {
      status: args.status,
      stripeCustomerId: args.stripeCustomerId ?? subscription.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId ?? subscription.stripeSubscriptionId,
      stripePlanItemId: args.stripePlanItemId ?? subscription.stripePlanItemId,
      currentPeriodStart: args.currentPeriodStart ?? subscription.currentPeriodStart,
      currentPeriodEnd: args.currentPeriodEnd ?? subscription.currentPeriodEnd,
      currentPeriodOverageSpentCents:
        args.currentPeriodStart && args.currentPeriodStart !== subscription.currentPeriodStart
          ? 0
          : subscription.currentPeriodOverageSpentCents,
      ...(args.cancelAtPeriodEnd !== undefined && { cancelAtPeriodEnd: args.cancelAtPeriodEnd }),
      ...(args.status === 'active'
        ? { gracePeriodSchedulerId: undefined, deletionSchedulerId: undefined }
        : {}),
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
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.units <= 0 || args.units % UNITS_PER_ADDON !== 0) {
      throw new Error(`units must be a positive multiple of ${UNITS_PER_ADDON}`);
    }

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
  returns: v.null(),
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
    await ctx.db.delete(purchase._id);
    await scheduleKVSync(ctx, subscription._id);
  },
});

export const revertToHobby = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return;

    // Cancel any pending grace->suspended scheduler before clearing the ID
    if (subscription.gracePeriodSchedulerId) {
      try {
        await ctx.scheduler.cancel(subscription.gracePeriodSchedulerId);
      } catch {
        // Already completed or canceled
      }
    }

    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const hobbyConfig = TIER_CONFIG.hobby;

    // Cancel any existing deletion scheduler before scheduling a new one
    if (subscription.deletionSchedulerId) {
      await ctx.scheduler.cancel(subscription.deletionSchedulerId);
    }

    // Schedule org data deletion 30 days from cancellation
    const deletionSchedulerId = await ctx.scheduler.runAfter(
      thirtyDaysMs,
      internal.admin.admin.deleteOrgDataScheduled,
      { orgId: args.orgId },
    );

    // stripeCustomerId intentionally retained so the customer can re-subscribe
    // without creating a duplicate Stripe customer
    await ctx.db.patch(subscription._id, {
      tier: 'hobby',
      status: 'active',
      monthlyUnits: hobbyConfig.monthlyUnits,
      addonUnits: 0,
      addonPurchaseCount: 0,
      currentPeriodOverageSpentCents: 0,
      autoOverage: false,
      overageCapCents: undefined,
      currentPeriodStart: now,
      currentPeriodEnd: now + thirtyDaysMs,
      stripeSubscriptionId: undefined,
      stripePlanItemId: undefined,
      cancelAtPeriodEnd: undefined,
      gracePeriodSchedulerId: undefined,
      deletionSchedulerId,
    });

    await scheduleKVSync(ctx, subscription._id);
  },
});

const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const scheduleGraceSuspension = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
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
      internal.billing.subscriptions.transitionGraceToSuspended,
      { orgId: args.orgId },
    );
    await ctx.db.patch(subscription._id, {
      gracePeriodSchedulerId: schedulerId,
    });
  },
});

export const transitionGraceToSuspended = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
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
