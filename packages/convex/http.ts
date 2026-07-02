import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HttpRouterWithHono } from 'convex-helpers/server/hono';
import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { registerRoutes as registerLaunchDarklyRoutes } from '@convex-dev/launchdarkly';
import {
  axiomConfigFromEnv,
  createConvexLogger,
  traceContextFromHeaders,
  type LogContext,
  type TraceContext,
} from '@trace-flow/logging';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { components, internal } from './_generated/api';
import * as oauthModule from './mcp/oauth';
import * as tokensModule from './mcp/tokens';
import { getPublicJwk } from './mcp/keys';
import { createMcpBackend } from './mcp/backend';
import { JWKS_PATH } from '@trace-flow/mcp-core';
import type Stripe from 'stripe';
import { UNITS_PER_ADDON } from '@trace-flow/types';
import { mapStripeStatusToInternal } from './billing/subscriptions';
import { getStripeClient, stripeWebhookSecret, stripeProPriceId } from './billing/stripe';
/**
 * Whether `redirectUri` is a loopback HTTP address (the CLI's local listener). The Collector login
 * flow delivers a freshly minted credential to this URL, so anything but `127.0.0.1` / `[::1]` /
 * `localhost` is rejected to prevent redirecting the secret to a third party.
 */
function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol !== 'http:') return false;
    return u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

function isSecureRedirectUri(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    if (u.hash || u.username || u.password) return false;
    return u.protocol === 'https:' || isLoopbackRedirect(redirectUri);
  } catch {
    return false;
  }
}

function canonicalizeMcpResource(resource: string): string | null {
  try {
    const u = new URL(resource);
    if (u.hash || u.username || u.password) return null;
    if (u.protocol !== 'https:' && !isLoopbackRedirect(resource)) return null;
    const serialized = u.toString();
    return u.pathname === '/' && !u.search ? serialized.replace(/\/$/, '') : serialized;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function hiddenInput(name: string, value: string | undefined): string {
  if (value === undefined) return '';
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function renderMcpConsentPage(params: {
  clientId: string;
  clientName?: string;
  responseType: string | null;
  clientState: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  consentToken: string;
}) {
  const redirectUrl = new URL(params.redirectUri);
  redirectUrl.searchParams.set('error', 'access_denied');
  redirectUrl.searchParams.set('error_description', 'User denied MCP authorization');
  if (params.clientState) redirectUrl.searchParams.set('state', params.clientState);

  const trimmedClientName = params.clientName?.trim();
  const clientLabel =
    trimmedClientName === undefined || trimmedClientName === ''
      ? params.clientId
      : trimmedClientName;
  const hidden = [
    hiddenInput('response_type', params.responseType ?? undefined),
    hiddenInput('client_id', params.clientId),
    hiddenInput('redirect_uri', params.redirectUri),
    hiddenInput('resource', params.resource),
    hiddenInput('state', params.clientState),
    hiddenInput('code_challenge', params.codeChallenge),
    hiddenInput('code_challenge_method', params.codeChallengeMethod),
    hiddenInput('consent_token', params.consentToken),
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize MCP Client</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    main {
      width: min(520px, calc(100vw - 32px));
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 8px;
      padding: 24px;
    }
    h1 { margin: 0 0 16px; font-size: 20px; line-height: 1.2; }
    dl { display: grid; gap: 12px; margin: 0 0 24px; }
    dt { font-size: 12px; font-weight: 700; text-transform: uppercase; color: color-mix(in srgb, CanvasText 62%, transparent); }
    dd { margin: 4px 0 0; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 12px; align-items: center; }
    button, a {
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 6px;
      padding: 9px 14px;
      font: inherit;
      color: CanvasText;
      text-decoration: none;
      background: Canvas;
    }
    button { background: CanvasText; color: Canvas; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize MCP Client</h1>
    <dl>
      <div>
        <dt>Client</dt>
        <dd>${escapeHtml(clientLabel)}</dd>
      </div>
      <div>
        <dt>Redirect URI</dt>
        <dd>${escapeHtml(params.redirectUri)}</dd>
      </div>
      <div>
        <dt>Resource</dt>
        <dd>${escapeHtml(params.resource)}</dd>
      </div>
      <div>
        <dt>Access</dt>
        <dd>Trace Flow account metadata and scoped analytics tokens for MCP tools.</dd>
      </div>
    </dl>
    <div class="actions">
      <form method="get" action="/mcp/authorize">
        ${hidden}
        <button type="submit">Continue</button>
      </form>
      <a href="${escapeHtml(redirectUrl.toString())}">Deny</a>
    </div>
  </main>
</body>
</html>`;
}

function consentMatchesRequest(
  consent: oauthModule.ConsentPayload | null,
  request: {
    clientId: string;
    clientState: string;
    redirectUri: string;
    resource: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    responseType: string | null;
  },
): boolean {
  return (
    consent !== null &&
    consent.clientId === request.clientId &&
    consent.clientState === request.clientState &&
    consent.redirectUri === request.redirectUri &&
    consent.resource === request.resource &&
    consent.codeChallenge === request.codeChallenge &&
    consent.codeChallengeMethod === request.codeChallengeMethod &&
    (consent.responseType ?? null) === request.responseType
  );
}

function bodyString(
  body: Record<string, string | File | (string | File)[]>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function hasValidBearerSecret(authHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret || !authHeader?.startsWith('Bearer ')) return false;
  return timingSafeEqual(authHeader.slice(7), secret);
}

function isJsonContentType(contentType: string | undefined): boolean {
  const normalized = contentType?.toLowerCase().trim();
  if (!normalized) return false;
  return normalized === 'application/json' || normalized.startsWith('application/json;');
}

const CONVEX_DOCUMENT_ID_PATTERN = /^[a-z0-9]{32}$/;

function isConvexDocumentId(value: unknown): value is string {
  return typeof value === 'string' && CONVEX_DOCUMENT_ID_PATTERN.test(value);
}

// Dependencies that can be injected for testing
export interface HttpDeps {
  oauth: typeof oauthModule;
  tokens: typeof tokensModule;
}

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

function getRequestLogger(request: Request, context?: LogContext) {
  return createConvexLogger({
    service: 'convex',
    convexFunction: 'http',
    axiom: axiomConfigFromEnv({
      AXIOM_TOKEN: process.env.AXIOM_TOKEN,
      AXIOM_DATASET: process.env.AXIOM_DATASET,
      AXIOM_DOMAIN: process.env.AXIOM_DOMAIN,
    }),
    context: {
      component: 'http',
      ...traceContextFromHeaders(request.headers),
      ...(context ?? {}),
    },
  });
}

// Factory function for creating the Hono app (exported for testing)
export function createApp(
  deps: HttpDeps = { oauth: oauthModule, tokens: tokensModule },
): HonoWithConvex<ActionCtx> {
  const { oauth, tokens } = deps;
  const app: HonoWithConvex<ActionCtx> = new Hono();

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      maxAge: 86400,
    }),
  );

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
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const orgId = session.metadata?.orgId as Id<'organizations'> | undefined;
          if (!orgId) break;
          const stripeSubId =
            typeof session.subscription === 'string' ? session.subscription : undefined;
          if (!stripeSubId || !session.customer || typeof session.customer !== 'string') break;
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
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const stripeSub = event.data.object;
          const customerId =
            typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id;
          const existing = await resolveOrgSubscription(ctx, customerId, stripeSub.id);
          if (!existing) break;
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
            planItem?.price?.id ??
            (typeof planItem?.price === 'string' ? planItem.price : undefined);
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
          break;
        }
        case 'customer.subscription.deleted': {
          const stripeSub = event.data.object;
          const customerId =
            typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id;
          const existing = await resolveOrgSubscription(ctx, customerId, stripeSub.id);
          if (!existing) break;
          await ctx.runMutation(internal.billing.subscriptions.revertToHobby, {
            orgId: existing.orgId,
          });
          break;
        }
        case 'invoice.paid': {
          const invoice = event.data.object;
          const customerId =
            typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;

          // Check if this is an addon purchase invoice (manual or auto-topup)
          const addonUnitsRaw = invoice.metadata?.addonUnits;
          if (addonUnitsRaw) {
            const orgIdRaw = invoice.metadata?.orgId as Id<'organizations'> | undefined;
            if (!orgIdRaw) {
              logger.error('convex.stripe_invoice_missing_org_id', undefined, {
                invoiceId: invoice.id,
                addonUnits: addonUnitsRaw,
              });
              break;
            }
            const units = Number(addonUnitsRaw);
            if (!Number.isFinite(units) || units <= 0 || units % UNITS_PER_ADDON !== 0) {
              logger.error('convex.stripe_invoice_invalid_units', undefined, {
                invoiceId: invoice.id,
                orgId: orgIdRaw,
                addonUnitsRaw,
                parsedUnits: units,
              });
              break;
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
              break;
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
            break;
          }

          // Subscription renewal invoice
          const parentSubscription = invoice.parent?.subscription_details?.subscription;
          const subscriptionId =
            typeof parentSubscription === 'string' ? parentSubscription : parentSubscription?.id;
          const existing = await resolveOrgSubscription(ctx, customerId, subscriptionId);
          if (!existing) break;

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
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object;

          // One-time addon invoices have no subscription parent — don't touch subscription status
          const parentSub = invoice.parent?.subscription_details?.subscription;
          if (!parentSub) break;

          const customerId =
            typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;
          const subscriptionId = typeof parentSub === 'string' ? parentSub : parentSub.id;
          const existing = await resolveOrgSubscription(ctx, customerId, subscriptionId);
          if (!existing) break;
          await ctx.runMutation(internal.billing.subscriptions.upsertStripeSubscriptionState, {
            orgId: existing.orgId,
            status: 'grace',
          });
          await ctx.runMutation(internal.billing.subscriptions.scheduleGraceSuspension, {
            orgId: existing.orgId,
          });
          break;
        }
        case 'charge.refunded': {
          const charge = event.data.object;
          const paymentIntentId =
            typeof charge.payment_intent === 'string'
              ? charge.payment_intent
              : charge.payment_intent?.id;
          if (!paymentIntentId) break;
          await ctx.runMutation(internal.billing.subscriptions.revokeAddonPurchase, {
            stripePaymentIntentId: paymentIntentId,
          });
          break;
        }
        default:
          break;
      }

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

  // OAuth: Discovery metadata (RFC 8414)
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const url = new URL(c.req.url);
    const issuer = url.origin;

    c.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/mcp/authorize`,
      token_endpoint: `${issuer}/mcp/token`,
      registration_endpoint: `${issuer}/mcp/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile', 'email'],
    });
  });

  // JWKS: public verification key for MCP access tokens. The MCP worker
  // (mcp.trace-flow.dev) fetches and caches this to verify RS256 tokens with no
  // Convex round trip. Rotate by publishing a second key here before retiring
  // the old kid. Cacheable — the key changes only on rotation.
  app.get(JWKS_PATH, async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'jwks' });
    try {
      const jwk = await getPublicJwk();
      c.header('Cache-Control', 'public, max-age=3600');
      return c.json({ keys: [jwk] });
    } catch (error) {
      logger.error('convex.jwks_unavailable', error);
      await logger.flush();
      return c.json({ error: 'jwks_unavailable' }, 500);
    }
  });

  // OAuth: Dynamic Client Registration (RFC 7591)
  app.post('/mcp/register', async (c) => {
    const ctx = c.env;

    let body: {
      redirect_uris?: string[];
      client_name?: string;
      client_uri?: string;
      logo_uri?: string;
      scope?: string;
    };

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Invalid JSON' }, 400);
    }

    if (
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length === 0 ||
      body.redirect_uris.some((uri) => typeof uri !== 'string' || !isSecureRedirectUri(uri))
    ) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description: 'At least one https or loopback http redirect_uri is required',
        },
        400,
      );
    }

    const redirectUris = body.redirect_uris;
    const clientId = crypto.randomUUID();

    await ctx.runMutation(internal.mcp.clients.registerClient, {
      clientId,
      redirectUris,
      clientName: body.client_name,
    });

    return c.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: body.client_name,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // OAuth: Start authorization flow
  app.get('/mcp/authorize', async (c) => {
    const ctx = c.env;
    const url = new URL(c.req.url);
    const responseType = url.searchParams.get('response_type');
    const clientId = url.searchParams.get('client_id');
    const clientState = url.searchParams.get('state') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri');
    const resource = url.searchParams.get('resource');
    const codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? undefined;

    if (responseType && responseType !== 'code') {
      return c.json(
        { error: 'unsupported_response_type', error_description: 'response_type must be code' },
        400,
      );
    }

    if (!clientId) {
      return c.json({ error: 'invalid_request', error_description: 'client_id is required' }, 400);
    }

    if (!redirectUri) {
      return c.json(
        { error: 'invalid_request', error_description: 'redirect_uri is required' },
        400,
      );
    }

    const client = await ctx.runQuery(internal.mcp.clients.getClient, { clientId });
    if (!Array.isArray(client?.redirectUris) || !client.redirectUris.includes(redirectUri)) {
      return c.json(
        { error: 'invalid_request', error_description: 'redirect_uri is not registered' },
        400,
      );
    }

    const canonicalResource = resource ? canonicalizeMcpResource(resource) : null;
    if (!canonicalResource) {
      return c.json({ error: 'invalid_request', error_description: 'resource is required' }, 400);
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'PKCE code_challenge_method must be S256',
        },
        400,
      );
    }

    const authorizeRequest = {
      clientId,
      clientState,
      redirectUri,
      resource: canonicalResource,
      codeChallenge,
      codeChallengeMethod,
      responseType,
    };
    const consentToken = url.searchParams.get('consent_token');
    const consent = consentToken ? await oauth.verifyConsent(consentToken) : null;

    if (!consentMatchesRequest(consent, authorizeRequest)) {
      const nextConsentToken = await oauth.signConsent({
        clientId,
        clientState,
        redirectUri,
        resource: canonicalResource,
        codeChallenge,
        codeChallengeMethod,
        ...(responseType === null ? {} : { responseType }),
      });

      return new Response(
        renderMcpConsentPage({
          clientId,
          clientName: client.clientName,
          responseType,
          clientState,
          redirectUri,
          resource: canonicalResource,
          codeChallenge,
          codeChallengeMethod,
          consentToken: nextConsentToken,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
            'Referrer-Policy': 'no-referrer',
          },
        },
      );
    }

    const callbackUrl = new URL('/mcp/callback', url.origin).toString();

    const state = await oauth.signState({
      clientState,
      clientId,
      redirectUri,
      resource: canonicalResource,
      codeChallenge,
      codeChallengeMethod,
    });

    const auth0Url = oauth.buildAuth0AuthorizeUrl(state, callbackUrl);

    // This branch is reached by the consent form's GET submission. Chrome checks the consent
    // page's `form-action 'self'` CSP against every redirect hop of that submission, so a 302
    // here (self -> Auth0, and on silent SSO all the way to the client's localhost callback)
    // gets blocked. A 200 HTML redirect ends the form-submission chain before the
    // cross-origin navigation.
    const redirectHtml = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=${auth0Url}">
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to authentication... <a href="${auth0Url}">Click here if not redirected</a></p>
  <script>window.location.replace("${auth0Url}");</script>
</body>
</html>`;

    return new Response(redirectHtml, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  });

  // OAuth: Handle Auth0 callback
  app.get('/mcp/callback', async (c) => {
    const ctx = c.env;
    const logger = getRequestLogger(c.req.raw, {
      operation: 'mcp_callback',
    });

    try {
      const url = new URL(c.req.url);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        const errorDescription = url.searchParams.get('error_description') ?? error;
        return c.json({ error: errorDescription }, 400);
      }

      if (!code || !state) {
        return c.json({ error: 'Missing code or state' }, 400);
      }

      const statePayload = await oauth.verifyState(state);
      if (!statePayload) {
        return c.json({ error: 'Invalid or expired state' }, 400);
      }

      const callbackUrl = new URL('/mcp/callback', url.origin).toString();

      // Exchange code for Auth0 tokens
      let auth0Tokens;
      try {
        auth0Tokens = await oauth.exchangeAuth0Code(code, callbackUrl);
      } catch (err) {
        logger.error('convex.auth0_token_exchange_failed', err);
        return c.json({ error: 'Auth0 token exchange failed', details: String(err) }, 500);
      }

      // Get user info from Auth0
      let userInfo;
      try {
        userInfo = await oauth.getAuth0UserInfo(auth0Tokens.access_token);
      } catch (err) {
        logger.error('convex.auth0_userinfo_failed', err);
        return c.json({ error: 'Failed to get user info', details: String(err) }, 500);
      }

      if (!userInfo.email) {
        return c.json({ error: 'Email is required' }, 400);
      }

      const domain = process.env.AUTH0_DOMAIN;
      const tokenIdentifier = `https://${domain}/|${userInfo.sub}`;

      // Find or create user
      const userId = await ctx.runMutation(internal.auth.users.findOrCreateUser, {
        tokenIdentifier,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
      });

      // Collector CLI device flow reuses this registered callback (Auth0 only allows /mcp/callback),
      // tagged by a `collector:` state prefix from /collector/authorize. Mint a Collector Credential
      // and hand the one-time secret back to the CLI's loopback listener instead of running the MCP
      // auth-code path. The redirect target is re-validated as loopback so the secret can only reach
      // 127.0.0.1.
      if (statePayload.clientState.startsWith('collector:')) {
        if (!isLoopbackRedirect(statePayload.redirectUri)) {
          logger.warn('convex.collector_login_bad_redirect');
          await logger.flush();
          return c.json({ error: 'Invalid redirect target' }, 400);
        }

        const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
        const collectorId = `cli-${crypto.randomUUID()}`;
        const minted = await ctx.runMutation(internal.collectorLogin.mintForUser, {
          userId,
          collectorId,
          expiresAt,
          name: 'Trace Flow CLI',
          platform: 'cli',
        });

        const redirectUrl = new URL(statePayload.redirectUri);
        redirectUrl.searchParams.set('secret', minted.secret);
        redirectUrl.searchParams.set('org_id', minted.orgId);
        redirectUrl.searchParams.set('collector_id', collectorId);
        redirectUrl.searchParams.set('expires_at', String(expiresAt));
        redirectUrl.searchParams.set('convex_url', url.origin);
        // Echo the CLI's one-time state nonce (the part after the `collector:` tag) back to the
        // loopback so the CLI can reject any local request that isn't the callback it initiated.
        redirectUrl.searchParams.set('state', statePayload.clientState.slice('collector:'.length));

        logger.info('convex.collector_login_minted', { org_id: minted.orgId });
        await logger.flush();
        return new Response(null, {
          status: 302,
          headers: { Location: redirectUrl.toString(), 'Cache-Control': 'no-store' },
        });
      }

      if (
        !statePayload.clientId ||
        !statePayload.resource ||
        !statePayload.codeChallenge ||
        statePayload.codeChallengeMethod !== 'S256'
      ) {
        return c.json({ error: 'Invalid or expired state' }, 400);
      }

      // Create authorization code (for code exchange at token endpoint)
      const authCode = await ctx.runMutation(internal.mcp.tokens.createAuthCode, {
        userId,
        clientId: statePayload.clientId,
        redirectUri: statePayload.redirectUri,
        resource: statePayload.resource,
        codeChallenge: statePayload.codeChallenge,
        codeChallengeMethod: statePayload.codeChallengeMethod,
        auth0RefreshToken: auth0Tokens.refresh_token ?? '',
      });

      // Redirect back to client with authorization code
      const redirectUrl = new URL(statePayload.redirectUri);
      redirectUrl.searchParams.set('code', authCode);
      if (statePayload.clientState) {
        redirectUrl.searchParams.set('state', statePayload.clientState);
      }

      // Explicit redirect with proper headers for browser compatibility
      await logger.flush();
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl.toString(),
          'Content-Length': '0',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    } catch (err) {
      logger.error('convex.oauth_callback_failed', err);
      await logger.flush();
      return c.json({ error: 'OAuth callback failed', details: String(err) }, 500);
    }
  });

  // OAuth: Token endpoint (for authorization code and refresh)
  app.post('/mcp/token', async (c) => {
    const ctx = c.env;
    const logger = getRequestLogger(c.req.raw, {
      operation: 'mcp_token',
    });

    try {
      const body = await c.req.parseBody();
      const grantType = body.grant_type;

      if (grantType === 'authorization_code') {
        const code = bodyString(body, 'code');
        const clientId = bodyString(body, 'client_id');
        const redirectUri = bodyString(body, 'redirect_uri');
        const resource = bodyString(body, 'resource');
        const codeVerifier = bodyString(body, 'code_verifier');

        if (!code) {
          return c.json({ error: 'invalid_request', error_description: 'code is required' }, 400);
        }

        if (!clientId) {
          return c.json(
            { error: 'invalid_request', error_description: 'client_id is required' },
            400,
          );
        }

        if (!redirectUri) {
          return c.json(
            { error: 'invalid_request', error_description: 'redirect_uri is required' },
            400,
          );
        }

        const canonicalResource = resource ? canonicalizeMcpResource(resource) : null;
        if (!canonicalResource) {
          return c.json(
            { error: 'invalid_request', error_description: 'resource is required' },
            400,
          );
        }

        if (!codeVerifier) {
          return c.json(
            { error: 'invalid_request', error_description: 'code_verifier is required' },
            400,
          );
        }

        const result = await ctx.runMutation(internal.mcp.tokens.exchangeAuthCode, {
          code,
          clientId,
          redirectUri,
          resource: canonicalResource,
          codeVerifier,
        });

        if ('error' in result) {
          return c.json(result, 400);
        }

        const issuer = new URL(c.req.url).origin;
        const accessToken = await tokens.createAccessToken(
          result.userId,
          result.tokenId,
          issuer,
          result.resource,
        );

        return c.json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: tokens.ACCESS_TOKEN_TTL_SECONDS,
          refresh_token: result.tokenId,
        });
      }

      if (grantType === 'refresh_token') {
        const refreshTokenId = bodyString(body, 'refresh_token');
        const clientId = bodyString(body, 'client_id');
        const resource = bodyString(body, 'resource');

        if (!refreshTokenId) {
          return c.json(
            { error: 'invalid_request', error_description: 'refresh_token is required' },
            400,
          );
        }

        if (!clientId) {
          return c.json(
            { error: 'invalid_request', error_description: 'client_id is required' },
            400,
          );
        }

        const canonicalResource = resource ? canonicalizeMcpResource(resource) : null;
        if (!canonicalResource) {
          return c.json(
            { error: 'invalid_request', error_description: 'resource is required' },
            400,
          );
        }

        const refreshToken = await ctx.runQuery(internal.mcp.tokens.getRefreshToken, {
          tokenId: refreshTokenId,
        });

        if (!refreshToken) {
          return c.json(
            { error: 'invalid_grant', error_description: 'Invalid or expired refresh token' },
            401,
          );
        }

        if (refreshToken.clientId !== clientId || refreshToken.resource !== canonicalResource) {
          return c.json(
            { error: 'invalid_grant', error_description: 'Invalid or expired refresh token' },
            401,
          );
        }

        const rotated = await ctx.runMutation(internal.mcp.tokens.rotateRefreshToken, {
          tokenId: refreshTokenId,
          clientId,
          resource: canonicalResource,
          auth0RefreshToken: refreshToken.auth0RefreshToken,
        });

        if ('error' in rotated) {
          return c.json(rotated, 401);
        }

        // Refresh Auth0 token if we have one
        if (refreshToken.auth0RefreshToken) {
          try {
            const newAuth0Tokens = await oauth.refreshAuth0Token(refreshToken.auth0RefreshToken);

            if (newAuth0Tokens.refresh_token) {
              await ctx.runMutation(internal.mcp.tokens.updateRefreshToken, {
                tokenId: rotated.tokenId,
                auth0RefreshToken: newAuth0Tokens.refresh_token,
              });
            }
          } catch (err) {
            logger.error('convex.auth0_token_refresh_failed', err);
          }
        }

        const issuer = new URL(c.req.url).origin;
        const accessToken = await tokens.createAccessToken(
          rotated.userId,
          rotated.tokenId,
          issuer,
          rotated.resource,
        );

        await logger.flush();
        return c.json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: tokens.ACCESS_TOKEN_TTL_SECONDS,
          refresh_token: rotated.tokenId,
        });
      }

      return c.json(
        { error: 'unsupported_grant_type', error_description: 'Unsupported grant_type' },
        400,
      );
    } catch (err) {
      logger.error('convex.mcp_token_failed', err);
      await logger.flush();
      return c.json({ error: 'server_error', error_description: 'Internal server error' }, 500);
    }
  });

  // Usage: DO pushes usage totals
  app.post('/usage/record', async (c) => {
    const ctx = c.env;
    const requestTraceContext = traceContextFromHeaders(c.req.raw.headers);

    const authHeader = c.req.header('Authorization');
    const secret = process.env.USAGE_SYNC_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = await c.req.json<{
      orgId: string;
      periodStart: number;
      periodEnd: number;
      subscriptionUnitsUsed: number;
      addonUnitsUsed: number;
      traceContext?: TraceContext;
    }>();
    const logger = getRequestLogger(c.req.raw, {
      operation: 'usage_record',
      ...(body.traceContext ?? requestTraceContext),
      orgId: body.orgId,
    });

    if (!isConvexDocumentId(body.orgId)) {
      logger.warn('convex.usage_org_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid organization id' }, 400);
    }

    const orgId = body.orgId as Id<'organizations'>;

    // Verify the org exists before recording usage
    const org = await ctx.runQuery(internal.auth.organizations.getByIdInternal, { id: orgId });
    if (!org) {
      logger.warn('convex.usage_org_not_found');
      await logger.flush();
      return c.json({ error: 'Organization not found' }, 404);
    }

    await ctx.runMutation(internal.billing.usage.recordUsage, {
      orgId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      subscriptionUnitsUsed: body.subscriptionUnitsUsed,
      addonUnitsUsed: body.addonUnitsUsed,
    });

    await ctx.runMutation(internal.billing.usage.checkAutoTopup, {
      orgId,
      subscriptionUnitsUsed: body.subscriptionUnitsUsed,
      addonUnitsUsed: body.addonUnitsUsed,
    });

    logger.info('convex.usage_recorded', {
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      subscriptionUnitsUsed: body.subscriptionUnitsUsed,
      addonUnitsUsed: body.addonUnitsUsed,
    });

    await logger.flush();
    return c.json({ ok: true });
  });

  // Agent ingest: Worker claims first-writer ownership of Agent Sessions before
  // enqueueing facts. Shared-secret guarded like /usage/record (the Worker, not
  // a browser, calls this). Partial-conflict batches skip only the conflicting
  // sessions and continue, so one historical conflict never blocks current work.
  app.post('/agent-ingest/claim-sessions', async (c) => {
    const ctx = c.env;
    const requestTraceContext = traceContextFromHeaders(c.req.raw.headers);

    const authHeader = c.req.header('Authorization');
    const secret = process.env.AGENT_INGEST_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = await c.req.json<{
      orgId: string;
      userId: string;
      collectorId: string;
      sessionPks: string[];
      traceContext?: TraceContext;
    }>();
    const logger = getRequestLogger(c.req.raw, {
      operation: 'agent_claim_sessions',
      ...(body.traceContext ?? requestTraceContext),
      orgId: body.orgId,
    });

    // Cap the batch so a single request can't fan out into unbounded claim
    // mutations. The ingest Worker chunks well under this.
    const MAX_SESSION_PKS = 1000;
    if (!Array.isArray(body.sessionPks) || body.sessionPks.length > MAX_SESSION_PKS) {
      logger.warn('convex.agent_claim_batch_too_large', { count: body.sessionPks?.length });
      await logger.flush();
      return c.json({ error: `sessionPks must be an array of at most ${MAX_SESSION_PKS}` }, 400);
    }

    if (!isConvexDocumentId(body.orgId)) {
      logger.warn('convex.agent_claim_org_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid organization id' }, 400);
    }

    const orgId = body.orgId as Id<'organizations'>;
    const org = await ctx.runQuery(internal.auth.organizations.getByIdInternal, { id: orgId });
    if (!org) {
      logger.warn('convex.agent_claim_org_not_found');
      await logger.flush();
      return c.json({ error: 'Organization not found' }, 404);
    }

    if (!isConvexDocumentId(body.userId)) {
      logger.warn('convex.agent_claim_user_id_invalid');
      await logger.flush();
      return c.json({ error: 'Invalid user id' }, 400);
    }

    const userId = body.userId as Id<'users'>;
    const user = await ctx.runQuery(internal.auth.users.getUserById, { id: userId });
    if (user?.orgId !== orgId) {
      logger.warn('convex.agent_claim_user_invalid', { userIdValid: Boolean(user) });
      await logger.flush();
      return c.json({ error: 'User not found in organization' }, 404);
    }

    // One batched mutation for the whole envelope's sessions: a single OCC transaction instead of one
    // round-trip per session. OCC still enforces first-writer per (orgId, session_pk) across
    // concurrent batches. The batch is bounded by MAX_SESSION_PKS above.
    const results = await ctx.runMutation(internal.agentSessionOwners.claimSessionsBatch, {
      orgId,
      sessionPks: body.sessionPks,
      userId,
      collectorId: body.collectorId,
    });

    const conflicts = results.filter((r) => r.status === 'conflict').length;
    logger.info('convex.agent_sessions_claimed', {
      requested: body.sessionPks.length,
      conflicts,
    });

    await logger.flush();
    return c.json({ results });
  });

  // Agent ingest: Worker fetches the compatibility policy (it edge-caches the
  // result). Empty policy → 404 so the Worker fails closed with
  // `policy_unavailable` rather than accepting unknown client versions.
  app.get('/agent-ingest/compatibility-policy', async (c) => {
    const ctx = c.env;

    const authHeader = c.req.header('Authorization');
    const secret = process.env.AGENT_INGEST_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const policy = await ctx.runQuery(
      internal.collectorCompatibilityPolicy.getActivePolicyInternal,
      {},
    );
    if (!policy) {
      const logger = getRequestLogger(c.req.raw, { operation: 'agent_compatibility_policy' });
      logger.warn('convex.agent_policy_unavailable');
      await logger.flush();
      return c.json({ error: 'policy_unavailable' }, 404);
    }

    return c.json(policy);
  });

  // MCP backend: the dedicated MCP worker (mcp.trace-flow.dev) calls these
  // shared-secret routes so raw API keys and the Tinybird admin token never
  // leave Convex. The worker holds neither — it forwards a userId + key ids and
  // receives only public metadata + a scoped, short-lived Tinybird JWT.
  app.post('/mcp-backend/context', async (c) => {
    const ctx = c.env;
    const authHeader = c.req.header('Authorization');
    const secret = process.env.MCP_BACKEND_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }

    const body = await c.req.json<{ userId: string }>();
    const backend = createMcpBackend(ctx, body.userId as Id<'users'>);
    const userContext = await backend.getUserContext();
    if (!userContext) {
      const logger = getRequestLogger(c.req.raw, { operation: 'mcp_backend_context' });
      logger.warn('convex.mcp_backend_user_not_found');
      await logger.flush();
      return c.json({ error: 'User not found' }, 404);
    }

    const apiKeys = await backend.listApiKeys();
    return c.json({
      enabled: userContext.enabled,
      retentionDays: userContext.retentionDays,
      apiKeys,
    });
  });

  app.post('/mcp-backend/mint', async (c) => {
    const ctx = c.env;
    const authHeader = c.req.header('Authorization');
    const secret = process.env.MCP_BACKEND_SHARED_SECRET;
    if (!hasValidBearerSecret(authHeader, secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }

    const body = await c.req.json<{
      userId: string;
      scopes: { type: string; resource: string }[];
      apiKeyIds: string[];
      ttlSeconds?: number;
    }>();
    const logger = getRequestLogger(c.req.raw, { operation: 'mcp_backend_mint' });

    const userId = body.userId as Id<'users'>;
    const backend = createMcpBackend(ctx, userId);

    const userContext = await backend.getUserContext();
    if (!userContext) {
      logger.warn('convex.mcp_backend_user_not_found');
      await logger.flush();
      return c.json({ error: 'User not found' }, 404);
    }
    if (!userContext.enabled) {
      logger.warn('convex.mcp_backend_user_disabled');
      await logger.flush();
      return c.json({ error: 'User account is not enabled' }, 403);
    }

    // Re-validate ownership server-side — never trust the worker's id list. The
    // worker already surfaced a clean InvalidParams to the client, so a bad id
    // here is a contract violation, hence 400.
    const resolved = await backend.resolveKeyIds(body.apiKeyIds);
    if (!resolved.ok) {
      logger.warn('convex.mcp_backend_unowned_key_ids', { invalidIds: resolved.invalidIds });
      await logger.flush();
      return c.json({ error: 'Unknown or unauthorized API key IDs' }, 400);
    }

    // retentionDays is derived server-side from the user's tier — the worker
    // never supplies it.
    let token: string;
    try {
      token = await backend.mintToken(
        body.scopes,
        resolved.keyIds,
        userContext.retentionDays,
        body.ttlSeconds,
      );
    } catch (error) {
      logger.error('convex.mcp_backend_mint_failed', error);
      await logger.flush();
      return c.json({ error: 'Failed to mint token' }, 500);
    }
    await logger.flush();
    return c.json({ token });
  });

  // Collector CLI login: start the browser device flow. The CLI opens this URL with a loopback
  // `redirect_uri`; we sign it into the OAuth state and bounce to Auth0, reusing the exact MCP
  // authorize machinery. The minted secret is delivered to that loopback by /collector/callback.
  app.get('/collector/authorize', async (c) => {
    const logger = getRequestLogger(c.req.raw, { operation: 'collector_authorize' });

    const url = new URL(c.req.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    const clientState = url.searchParams.get('state') ?? '';
    if (!redirectUri) {
      return c.json({ error: 'redirect_uri is required' }, 400);
    }
    // Loopback only: the CLI listens on 127.0.0.1, so a non-loopback redirect is an attempt to
    // exfiltrate a freshly minted credential to a third party. Reject it outright.
    if (!isLoopbackRedirect(redirectUri)) {
      logger.warn('convex.collector_authorize_bad_redirect');
      await logger.flush();
      return c.json({ error: 'redirect_uri must be a loopback (127.0.0.1) address' }, 400);
    }

    // Reuse the registered /mcp/callback (Auth0 only allows that path); the `collector:` state tag
    // tells the shared callback to mint a Collector Credential rather than run the MCP auth-code path.
    const callbackUrl = new URL('/mcp/callback', url.origin).toString();
    const state = await oauth.signState({ clientState: `collector:${clientState}`, redirectUri });
    const auth0Url = oauth.buildAuth0AuthorizeUrl(state, callbackUrl);

    await logger.flush();
    return new Response(null, {
      status: 302,
      headers: { Location: auth0Url, 'Cache-Control': 'no-store' },
    });
  });

  return app;
}

// Production export (unchanged behavior)
const httpRouter = new HttpRouterWithHono(createApp());

// LaunchDarkly webhook (component pushes flag updates here).
registerLaunchDarklyRoutes(components.launchdarkly, httpRouter);

export default httpRouter;
