import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type Stripe from 'stripe';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getStripeClient, stripeWebhookSecret } from '../billing/stripe';
import { getRequestLogger } from './shared';
import { applyStripeEvent } from './stripeWebhookEvents';

export function registerStripeWebhookRoutes(app: HonoWithConvex<ActionCtx>): void {
  app.post('/stripe/webhook', async (c) => {
    const ctx = c.env;
    const logger = getRequestLogger(c.req.raw, {
      operation: 'stripe_webhook',
    });
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      logger.error('convex.stripe_webhook_missing_signature');
      await logger.flush();
      return c.json({ error: 'Missing stripe-signature header' }, 400);
    }
    if (!stripeWebhookSecret) {
      logger.error('convex.stripe_webhook_missing_secret');
      await logger.flush();
      return c.json({ error: 'STRIPE_WEBHOOK_SECRET environment variable is not set' }, 500);
    }

    const rawBody = await c.req.text();
    const stripe = getStripeClient();

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, stripeWebhookSecret);
    } catch (error) {
      logger.error('convex.stripe_webhook_signature_invalid', error, {
        signaturePrefix: signature.slice(0, 20),
        secretPrefix: stripeWebhookSecret.slice(0, 8),
        bodyLength: rawBody.length,
      });
      await logger.flush();
      return c.json(
        {
          error: 'Invalid webhook signature',
          details: error instanceof Error ? error.message : '',
        },
        400,
      );
    }

    const start = await ctx.runMutation(internal.billing.stripeEvents.startProcessing, {
      eventId: event.id,
      eventType: event.type,
      stripeObjectId:
        typeof event.data.object === 'object' && event.data.object && 'id' in event.data.object
          ? ((event.data.object as { id?: string }).id ?? undefined)
          : undefined,
    });
    if (start.alreadyProcessed) {
      return c.json({ ok: true, deduped: true });
    }

    try {
      await applyStripeEvent(ctx, stripe, event, logger);

      await ctx.runMutation(internal.billing.stripeEvents.markProcessed, { eventId: event.id });
      await logger.flush();
      return c.json({ ok: true });
    } catch (error) {
      logger.error('convex.stripe_webhook_processing_failed', error, {
        eventId: event.id,
        eventType: event.type,
      });
      await ctx.runMutation(internal.billing.stripeEvents.markFailed, {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await logger.flush();
      // Return 500 so Stripe retries. Idempotency table prevents double-processing.
      return c.json({ ok: false, error: 'processing_failed' }, 500);
    }
  });
}
