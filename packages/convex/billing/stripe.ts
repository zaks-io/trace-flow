import Stripe from 'stripe';

export const STRIPE_API_VERSION = '2026-02-25.clover';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
export const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

export const stripeProPriceId = process.env.STRIPE_PRICE_ID_PRO;
export const stripeAddonPriceId = process.env.STRIPE_PRICE_ID_ADDON;
export const appUrl = process.env.APP_URL ?? 'http://localhost:3000';

export function getStripeClient() {
  if (!stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not set');
  }
  return new Stripe(stripeSecretKey, { apiVersion: STRIPE_API_VERSION });
}

export function getProPriceId(): string {
  if (!stripeProPriceId) {
    throw new Error('STRIPE_PRICE_ID_PRO environment variable is not set');
  }
  return stripeProPriceId;
}

export function getAddonPriceId(): string {
  if (!stripeAddonPriceId) {
    throw new Error('STRIPE_PRICE_ID_ADDON environment variable is not set');
  }
  return stripeAddonPriceId;
}
