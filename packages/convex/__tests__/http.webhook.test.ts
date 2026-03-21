import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Set env vars before http.ts is imported (module-level const captures at load time)
const { mockConstructEvent, mockSubscriptionsRetrieve, mockInvoicePaymentsList } = vi.hoisted(
  () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
    process.env.STRIPE_PRICE_ID_PRO = 'price_pro';
    return {
      mockConstructEvent: vi.fn(),
      mockSubscriptionsRetrieve: vi.fn(),
      mockInvoicePaymentsList: vi.fn(),
    };
  },
);

vi.mock('stripe', () => ({
  default: class StripeMock {
    webhooks = { constructEventAsync: mockConstructEvent };
    subscriptions = { retrieve: mockSubscriptionsRetrieve };
    invoicePayments = { list: mockInvoicePaymentsList };
  },
}));

import { createApp, type HttpDeps } from '../http';

interface MockCtx {
  runMutation: Mock;
  runQuery: Mock;
  runAction: Mock;
}

function createMockCtx(): MockCtx {
  return {
    runMutation: vi.fn(),
    runQuery: vi.fn(),
    runAction: vi.fn(),
  };
}

function createMockDeps(): HttpDeps {
  return {
    oauth: {
      signState: vi.fn(),
      verifyState: vi.fn(),
      buildAuth0AuthorizeUrl: vi.fn(),
      exchangeAuth0Code: vi.fn(),
      getAuth0UserInfo: vi.fn(),
      refreshAuth0Token: vi.fn(),
    } as unknown as HttpDeps['oauth'],
    tokens: {
      createAccessToken: vi.fn(),
      validateAccessToken: vi.fn(),
      ACCESS_TOKEN_TTL_SECONDS: 3600,
    } as unknown as HttpDeps['tokens'],
  };
}

function makeStripeEvent(
  type: string,
  object: Record<string, unknown>,
  id = `evt_${Math.random().toString(36).slice(2)}`,
) {
  return { id, type, data: { object } };
}

function webhookRequest(body: string, signature = 'sig_valid') {
  return {
    method: 'POST' as const,
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    },
    body,
  };
}

describe('POST /stripe/webhook', () => {
  let ctx: MockCtx;
  let deps: HttpDeps;

  beforeEach(() => {
    ctx = createMockCtx();
    deps = createMockDeps();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Signature validation ──────────────────────────────────────────

  describe('signature validation', () => {
    it('returns 400 when stripe-signature header is missing', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Missing stripe-signature header');
    });

    it('returns 400 when signature verification fails', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Signature verification failed');
      });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest('{"id":"evt_1"}'),
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Invalid webhook signature');
      expect(json.details).toContain('Signature verification failed');
    });

    it('passes raw body and signature to constructEventAsync', async () => {
      mockConstructEvent.mockReturnValue(
        makeStripeEvent('test.event', { id: 'obj_1' }, 'evt_sig_test'),
      );
      ctx.runMutation.mockResolvedValue({ alreadyProcessed: true, eventDocId: 'doc_1' });

      const body = '{"raw":"payload"}';
      const app = createApp(deps);
      await app.request('http://localhost/stripe/webhook', webhookRequest(body, 'sig_abc'), ctx);

      expect(mockConstructEvent).toHaveBeenCalledWith(body, 'sig_abc', 'whsec_test_123');
    });
  });

  // ── Idempotency ───────────────────────────────────────────────────

  describe('idempotency', () => {
    it('returns deduped:true when event was already processed', async () => {
      const event = makeStripeEvent('customer.subscription.updated', { id: 'sub_1' });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: true, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.deduped).toBe(true);
    });

    it('processes new events and marks them as processed', async () => {
      const event = makeStripeEvent('some.unknown.type', { id: 'obj_1' });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation
        .mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' }) // startProcessing
        .mockResolvedValueOnce(undefined); // markProcessed

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      // startProcessing + markProcessed = 2 calls
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });
  });

  // ── Event routing: checkout.session.completed ─────────────────────

  describe('checkout.session.completed', () => {
    it('sets up subscription after successful checkout', async () => {
      const event = makeStripeEvent('checkout.session.completed', {
        id: 'cs_1',
        metadata: { orgId: 'org123' },
        subscription: 'sub_1',
        customer: 'cus_1',
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValue({ alreadyProcessed: false, eventDocId: 'doc_1' });

      mockSubscriptionsRetrieve.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
        items: {
          data: [
            {
              id: 'si_plan',
              price: { id: 'price_pro' },
              quantity: 1,
              current_period_start: 1700000000,
              current_period_end: 1702592000,
            },
          ],
        },
      });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // Calls: startProcessing, setStripeCustomerId, upsertStripeSubscriptionState, setTier, markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(5);
      // setStripeCustomerId call
      const setCustomerCall = ctx.runMutation.mock.calls[1];
      expect(setCustomerCall[1]).toEqual({ orgId: 'org123', stripeCustomerId: 'cus_1' });
      // upsertStripeSubscriptionState call
      const upsertCall = ctx.runMutation.mock.calls[2];
      expect(upsertCall[1]).toMatchObject({
        orgId: 'org123',
        status: 'active',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        stripePlanItemId: 'si_plan',
      });
      expect(upsertCall[1]).not.toHaveProperty('stripeSeatItemId');
      expect(upsertCall[1]).not.toHaveProperty('seatQuantity');
      // setTier call
      const setTierCall = ctx.runMutation.mock.calls[3];
      expect(setTierCall[1]).toEqual({ orgId: 'org123', tier: 'pro' });
    });

    it('skips when orgId is missing from metadata', async () => {
      const event = makeStripeEvent('checkout.session.completed', {
        id: 'cs_1',
        metadata: {},
        subscription: 'sub_1',
        customer: 'cus_1',
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValue({ alreadyProcessed: false, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // Only startProcessing + markProcessed (skipped the handler)
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });

    it('skips when subscription is missing', async () => {
      const event = makeStripeEvent('checkout.session.completed', {
        id: 'cs_1',
        metadata: { orgId: 'org123' },
        customer: 'cus_1',
        // no subscription
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValue({ alreadyProcessed: false, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });
  });

  // ── Event routing: customer.subscription.created / updated ────────

  describe('customer.subscription.created', () => {
    it('upserts subscription state for a known org', async () => {
      const event = makeStripeEvent('customer.subscription.created', {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: 'si_plan',
              price: { id: 'price_pro' },
              quantity: 1,
              current_period_start: 1700000000,
              current_period_end: 1702592000,
            },
          ],
        },
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      // resolveOrgSubscription: getByStripeSubscriptionId returns existing
      ctx.runQuery.mockResolvedValueOnce({ orgId: 'org123', stripePlanItemId: 'si_old' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // startProcessing + upsertStripeSubscriptionState + setTier + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(4);
      const upsertCall = ctx.runMutation.mock.calls[1];
      expect(upsertCall[1]).toMatchObject({
        orgId: 'org123',
        status: 'active',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        cancelAtPeriodEnd: false,
      });
      // setTier call — price_pro matches env var so tier is 'pro'
      const setTierCall = ctx.runMutation.mock.calls[2];
      expect(setTierCall[1]).toEqual({ orgId: 'org123', tier: 'pro' });
    });

    it('skips when subscription is not found for any org', async () => {
      const event = makeStripeEvent('customer.subscription.created', {
        id: 'sub_unknown',
        customer: 'cus_unknown',
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [] },
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      // resolveOrgSubscription: all lookups return null
      ctx.runQuery.mockResolvedValue(null);

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // Only startProcessing + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });
  });

  describe('customer.subscription.updated', () => {
    it('updates subscription with cancel_at_period_end', async () => {
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: true,
        items: {
          data: [
            {
              id: 'si_plan',
              price: { id: 'price_pro' },
              quantity: 1,
              current_period_start: 1700000000,
              current_period_end: 1702592000,
            },
          ],
        },
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      ctx.runQuery.mockResolvedValueOnce({ orgId: 'org123' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      const upsertCall = ctx.runMutation.mock.calls[1];
      expect(upsertCall[1]).toMatchObject({
        cancelAtPeriodEnd: true,
      });
    });

    it('preserves grace status when subscription is past_due', async () => {
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'past_due',
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: 'si_plan',
              price: { id: 'price_pro' },
              quantity: 1,
              current_period_start: 1700000000,
              current_period_end: 1702592000,
            },
          ],
        },
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      ctx.runQuery.mockResolvedValueOnce({ orgId: 'org123' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // startProcessing + upsert + setTier + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(4);
      const upsertCall = ctx.runMutation.mock.calls[1];
      expect(upsertCall[1]).toMatchObject({
        orgId: 'org123',
        status: 'grace', // past_due maps to grace
        cancelAtPeriodEnd: false,
      });
      // setTier should NOT overwrite status — only tier and monthlyUnits
      const setTierCall = ctx.runMutation.mock.calls[2];
      expect(setTierCall[1]).toEqual({ orgId: 'org123', tier: 'pro' });
    });

    it('resolves org via customer ID fallback through org table', async () => {
      const event = makeStripeEvent('customer.subscription.updated', {
        id: 'sub_new',
        customer: 'cus_1',
        status: 'trialing',
        cancel_at_period_end: false,
        items: { data: [] },
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      // resolveOrgSubscription: getByStripeSubscriptionId → null
      ctx.runQuery.mockResolvedValueOnce(null);
      // getByStripeCustomerId → null
      ctx.runQuery.mockResolvedValueOnce(null);
      // getByStripeCustomerId on org table → org found
      ctx.runQuery.mockResolvedValueOnce({ _id: 'org123' });
      // getByOrgId → subscription found
      ctx.runQuery.mockResolvedValueOnce({ orgId: 'org123' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // startProcessing + upsert + setTier + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(4);
      const upsertCall = ctx.runMutation.mock.calls[1];
      expect(upsertCall[1]).toMatchObject({
        orgId: 'org123',
        status: 'active', // trialing maps to active
      });
      // setTier — no price in items.data so tier falls back to hobby
      const setTierCall = ctx.runMutation.mock.calls[2];
      expect(setTierCall[1]).toEqual({ orgId: 'org123', tier: 'hobby' });
    });
  });

  // ── Event routing: customer.subscription.deleted ──────────────────

  describe('customer.subscription.deleted', () => {
    it('reverts org to hobby tier', async () => {
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_1',
        customer: 'cus_1',
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      ctx.runQuery.mockResolvedValueOnce({ orgId: 'org123' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // startProcessing + revertToHobby + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(3);
      const revertCall = ctx.runMutation.mock.calls[1];
      expect(revertCall[1]).toEqual({ orgId: 'org123' });
    });

    it('skips when no existing subscription found', async () => {
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_unknown',
        customer: 'cus_unknown',
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      ctx.runQuery.mockResolvedValue(null);

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });
  });

  // ── Event routing: invoice.paid ───────────────────────────────────

  describe('invoice.paid', () => {
    it('credits addon purchase when addonUnits metadata is present', async () => {
      const event = makeStripeEvent('invoice.paid', {
        id: 'in_1',
        customer: 'cus_1',
        amount_paid: 1000,
        metadata: {
          addonUnits: '100000',
          orgId: 'org123',
          ownerUserId: 'user_1',
          mode: 'manual',
        },
        parent: null,
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });

      mockInvoicePaymentsList.mockResolvedValue({
        data: [
          {
            payment: {
              type: 'payment_intent',
              payment_intent: 'pi_1',
            },
          },
        ],
      });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // startProcessing + creditAddonPurchase + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(3);
      const creditCall = ctx.runMutation.mock.calls[1];
      expect(creditCall[1]).toMatchObject({
        orgId: 'org123',
        units: 100000,
        amountCents: 1000,
        stripePaymentIntentId: 'pi_1',
        stripeInvoiceId: 'in_1',
        mode: 'manual',
        triggeredByUserId: 'user_1',
      });
    });

    it('handles auto mode addon purchase', async () => {
      const event = makeStripeEvent('invoice.paid', {
        id: 'in_2',
        customer: 'cus_1',
        amount_paid: 500,
        metadata: {
          addonUnits: '200000',
          orgId: 'org123',
          mode: 'auto',
        },
        parent: null,
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      mockInvoicePaymentsList.mockResolvedValue({
        data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_2' } }],
      });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      const creditCall = ctx.runMutation.mock.calls[1];
      expect(creditCall[1]).toMatchObject({ mode: 'auto' });
    });

    it('upserts subscription state for subscription renewal', async () => {
      const event = makeStripeEvent('invoice.paid', {
        id: 'in_3',
        customer: 'cus_1',
        amount_paid: 2900,
        metadata: {},
        parent: {
          subscription_details: { subscription: 'sub_1' },
        },
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      // resolveOrgSubscription
      ctx.runQuery.mockResolvedValueOnce({
        orgId: 'org123',
        stripePlanItemId: 'si_plan_old',
        currentPeriodStart: 1700000000000,
        currentPeriodEnd: 1702592000000,
      });
      mockSubscriptionsRetrieve.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
        items: {
          data: [
            {
              id: 'si_plan',
              price: { id: 'price_pro' },
              quantity: 1,
              current_period_start: 1702592000,
              current_period_end: 1705184000,
            },
          ],
        },
      });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // startProcessing + upsertStripeSubscriptionState + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(3);
      const upsertCall = ctx.runMutation.mock.calls[1];
      expect(upsertCall[1]).toMatchObject({
        orgId: 'org123',
        status: 'active',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        currentPeriodStart: 1702592000 * 1000,
        currentPeriodEnd: 1705184000 * 1000,
      });
    });

    it('skips addon credit when addonUnits is not a valid number', async () => {
      const event = makeStripeEvent('invoice.paid', {
        id: 'in_4',
        customer: 'cus_1',
        amount_paid: 0,
        metadata: {
          addonUnits: 'notanumber',
          orgId: 'org123',
        },
        parent: null,
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // NaN is not finite, so the handler breaks out — only startProcessing + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });

    it('skips when customerId is missing', async () => {
      const event = makeStripeEvent('invoice.paid', {
        id: 'in_5',
        customer: null,
        amount_paid: 0,
        metadata: {},
        parent: null,
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });
  });

  // ── Event routing: invoice.payment_failed ─────────────────────────

  describe('invoice.payment_failed', () => {
    it('sets subscription to grace and schedules suspension', async () => {
      const event = makeStripeEvent('invoice.payment_failed', {
        id: 'in_fail_1',
        customer: 'cus_1',
        parent: {
          subscription_details: { subscription: 'sub_1' },
        },
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      // resolveOrgSubscription
      ctx.runQuery.mockResolvedValueOnce({ orgId: 'org123' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // startProcessing + upsertStripeSubscriptionState(grace) + scheduleGraceSuspension + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(4);
      const upsertCall = ctx.runMutation.mock.calls[1];
      expect(upsertCall[1]).toMatchObject({
        orgId: 'org123',
        status: 'grace',
      });
    });

    it('skips when subscription not found', async () => {
      const event = makeStripeEvent('invoice.payment_failed', {
        id: 'in_fail_2',
        customer: 'cus_unknown',
        parent: null,
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      ctx.runQuery.mockResolvedValue(null);

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });
  });

  // ── Event routing: charge.refunded ────────────────────────────────

  describe('charge.refunded', () => {
    it('revokes addon purchase by payment intent', async () => {
      const event = makeStripeEvent('charge.refunded', {
        id: 'ch_1',
        payment_intent: 'pi_1',
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      // startProcessing + revokeAddonPurchase + markProcessed
      expect(ctx.runMutation).toHaveBeenCalledTimes(3);
      const revokeCall = ctx.runMutation.mock.calls[1];
      expect(revokeCall[1]).toMatchObject({
        stripePaymentIntentId: 'pi_1',
      });
    });

    it('skips when payment_intent is missing', async () => {
      const event = makeStripeEvent('charge.refunded', {
        id: 'ch_2',
        payment_intent: null,
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    });

    it('handles expanded payment_intent object', async () => {
      const event = makeStripeEvent('charge.refunded', {
        id: 'ch_3',
        payment_intent: { id: 'pi_expanded' },
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      const revokeCall = ctx.runMutation.mock.calls[1];
      expect(revokeCall[1]).toMatchObject({
        stripePaymentIntentId: 'pi_expanded',
      });
    });
  });

  // ── Unknown event types ───────────────────────────────────────────

  describe('unknown event types', () => {
    it('acks unknown event types without error', async () => {
      const event = makeStripeEvent('payment_method.attached', { id: 'pm_1' });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });
  });

  // ── Error handling ────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns 500 and marks event as failed when processing throws', async () => {
      const event = makeStripeEvent('customer.subscription.deleted', {
        id: 'sub_1',
        customer: 'cus_1',
      });
      mockConstructEvent.mockReturnValue(event);
      ctx.runMutation.mockResolvedValueOnce({ alreadyProcessed: false, eventDocId: 'doc_1' });
      ctx.runQuery.mockResolvedValueOnce({ orgId: 'org123' });
      // revertToHobby throws
      ctx.runMutation.mockRejectedValueOnce(new Error('DB write failed'));

      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/stripe/webhook',
        webhookRequest(JSON.stringify(event)),
        ctx,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toBe('processing_failed');
      // markFailed should have been called
      const markFailedCall = ctx.runMutation.mock.calls[2];
      expect(markFailedCall[1]).toMatchObject({
        eventId: event.id,
        error: 'DB write failed',
      });
    });
  });
});
