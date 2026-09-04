import type Stripe from 'stripe';
import type { Logger } from '@trace-flow/logging';
import { UNITS_PER_ADDON } from '@trace-flow/types';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { mapStripeStatusToInternal } from '../billing/subscriptions';
import { stripeProPriceId } from '../billing/stripe';

async function resolveOrgSubscription(ctx: ActionCtx, customerId: string, subscriptionId?: string) {
  if (subscriptionId) {
    const bySub = await ctx.runQuery(internal.billing.subscriptions.getByStripeSubscriptionId, {
      stripeSubscriptionId: subscriptionId,
    });
    if (bySub) return bySub;
  }

  // Check subscription table first, then fall back to org table
  const byCust = await ctx.runQuery(internal.billing.subscriptions.getByStripeCustomerId, {
    stripeCustomerId: customerId,
  });
  if (byCust) return byCust;

  const org = await ctx.runQuery(internal.auth.organizations.getByStripeCustomerId, {
    stripeCustomerId: customerId,
  });
  if (org) {
    return await ctx.runQuery(internal.billing.subscriptions.getByOrgId, { orgId: org._id });
  }

  return null;
}

export async function applyStripeEvent(
  ctx: ActionCtx,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const orgId = session.metadata?.orgId as Id<'organizations'> | undefined;
      if (!orgId) return;
      const stripeSubId =
        typeof session.subscription === 'string' ? session.subscription : undefined;
      if (!stripeSubId || !session.customer || typeof session.customer !== 'string') return;
      // Ensure org has the customer ID persisted
      await ctx.runMutation(internal.auth.organizations.setStripeCustomerId, {
        orgId,
        stripeCustomerId: session.customer,
      });
      const sub = await stripe.subscriptions.retrieve(stripeSubId);
      const planItem = sub.items.data[0];
      await ctx.runMutation(internal.billing.subscriptions.upsertStripeSubscriptionState, {
        orgId,
        status: mapStripeStatusToInternal(sub.status),
        stripeCustomerId: session.customer,
        stripeSubscriptionId: sub.id,
        stripePlanItemId: planItem?.id,
        currentPeriodStart: (planItem?.current_period_start ?? 0) * 1000,
        currentPeriodEnd: (planItem?.current_period_end ?? 0) * 1000,
      });
      await ctx.runMutation(internal.billing.subscriptions.setTier, {
        orgId,
        tier: 'pro',
      });
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const stripeSub = event.data.object;
      const customerId =
        typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id;
      const existing = await resolveOrgSubscription(ctx, customerId, stripeSub.id);
      if (!existing) return;
      const planItem = stripeSub.items.data[0];
      await ctx.runMutation(internal.billing.subscriptions.upsertStripeSubscriptionState, {
        orgId: existing.orgId,
        status: mapStripeStatusToInternal(stripeSub.status),
        stripeCustomerId: customerId,
        stripeSubscriptionId: stripeSub.id,
        stripePlanItemId: planItem?.id,
        currentPeriodStart: (planItem?.current_period_start ?? 0) * 1000,
        currentPeriodEnd: (planItem?.current_period_end ?? 0) * 1000,
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      });
      const priceId =
        planItem?.price?.id ?? (typeof planItem?.price === 'string' ? planItem.price : undefined);
      if (!stripeProPriceId) {
        logger.error('convex.stripe_webhook_missing_pro_price_id', undefined, {
          event: event.type,
          hint: 'STRIPE_PRICE_ID_PRO env var is not set — tier detection will default to hobby',
        });
      }
      const tier = priceId === stripeProPriceId ? 'pro' : 'hobby';
      await ctx.runMutation(internal.billing.subscriptions.setTier, {
        orgId: existing.orgId,
        tier,
      });
      return;
    }
    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object;
      const customerId =
        typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id;
      const existing = await resolveOrgSubscription(ctx, customerId, stripeSub.id);
      if (!existing) return;
      await ctx.runMutation(internal.billing.subscriptions.revertToHobby, {
        orgId: existing.orgId,
      });
      return;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;

      // Check if this is an addon purchase invoice (manual or auto-topup)
      const addonUnitsRaw = invoice.metadata?.addonUnits;
      if (addonUnitsRaw) {
        const orgIdRaw = invoice.metadata?.orgId as Id<'organizations'> | undefined;
        if (!orgIdRaw) {
          logger.error('convex.stripe_invoice_missing_org_id', undefined, {
            invoiceId: invoice.id,
            addonUnits: addonUnitsRaw,
          });
          return;
        }
        const units = Number(addonUnitsRaw);
        if (!Number.isFinite(units) || units <= 0 || units % UNITS_PER_ADDON !== 0) {
          logger.error('convex.stripe_invoice_invalid_units', undefined, {
            invoiceId: invoice.id,
            orgId: orgIdRaw,
            addonUnitsRaw,
            parsedUnits: units,
          });
          return;
        }
        const mode = invoice.metadata?.mode === 'auto' ? 'auto' : 'manual';

        // In Stripe v20+, payment_intent is on invoice payments, not top-level
        const invoicePayments = await stripe.invoicePayments.list({
          invoice: invoice.id,
          limit: 1,
        });
        const payment = invoicePayments.data[0]?.payment;
        const paymentIntentId =
          payment?.type === 'payment_intent'
            ? typeof payment.payment_intent === 'string'
              ? payment.payment_intent
              : payment.payment_intent?.id
            : undefined;
        if (!paymentIntentId) {
          logger.error('convex.stripe_invoice_missing_payment_intent', undefined, {
            invoiceId: invoice.id,
            orgId: orgIdRaw,
            units,
            paymentData: payment ? { type: payment.type } : 'no_payments',
          });
          return;
        }

        const ownerUserId = invoice.metadata?.ownerUserId as Id<'users'> | undefined;

        await ctx.runMutation(internal.billing.subscriptions.creditAddonPurchase, {
          orgId: orgIdRaw,
          units,
          amountCents: invoice.amount_paid,
          stripePaymentIntentId: paymentIntentId,
          stripeInvoiceId: invoice.id,
          mode,
          triggeredByUserId: ownerUserId,
        });
        return;
      }

      // Subscription renewal invoice
      const parentSubscription = invoice.parent?.subscription_details?.subscription;
      const subscriptionId =
        typeof parentSubscription === 'string' ? parentSubscription : parentSubscription?.id;
      const existing = await resolveOrgSubscription(ctx, customerId, subscriptionId);
      if (!existing) return;

      const stripeSub = subscriptionId
        ? await stripe.subscriptions.retrieve(subscriptionId)
        : undefined;
      const planItem = stripeSub?.items.data[0];
      await ctx.runMutation(internal.billing.subscriptions.upsertStripeSubscriptionState, {
        orgId: existing.orgId,
        status: 'active',
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripePlanItemId: planItem?.id ?? existing.stripePlanItemId,
        currentPeriodStart: planItem?.current_period_start
          ? planItem.current_period_start * 1000
          : existing.currentPeriodStart,
        currentPeriodEnd: planItem?.current_period_end
          ? planItem.current_period_end * 1000
          : existing.currentPeriodEnd,
        cancelAtPeriodEnd: false,
      });
      return;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;

      // One-time addon invoices have no subscription parent — don't touch subscription status
      const parentSub = invoice.parent?.subscription_details?.subscription;
      if (!parentSub) return;

      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      const subscriptionId = typeof parentSub === 'string' ? parentSub : parentSub.id;
      const existing = await resolveOrgSubscription(ctx, customerId, subscriptionId);
      if (!existing) return;
      await ctx.runMutation(internal.billing.subscriptions.upsertStripeSubscriptionState, {
        orgId: existing.orgId,
        status: 'grace',
      });
      await ctx.runMutation(internal.billing.subscriptions.scheduleGraceSuspension, {
        orgId: existing.orgId,
      });
      return;
    }
    case 'charge.refunded': {
      const charge = event.data.object;
      const paymentIntentId =
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id;
      if (!paymentIntentId) return;
      await ctx.runMutation(internal.billing.subscriptions.revokeAddonPurchase, {
        stripePaymentIntentId: paymentIntentId,
      });
      return;
    }
    default:
      return;
  }
}
