import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HttpRouterWithHono } from 'convex-helpers/server/hono';
import type { HonoWithConvex } from 'convex-helpers/server/hono';
import {
  axiomConfigFromEnv,
  createConvexLogger,
  traceContextFromHeaders,
  type LogContext,
  type TraceContext,
  type Logger,
} from '@trace-flow/logging';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import * as oauthModule from './mcp/oauth';
import * as tokensModule from './mcp/tokens';
import type Stripe from 'stripe';
import { UNITS_PER_ADDON } from '@trace-flow/types';
import { mapStripeStatusToInternal } from './billing/subscriptions';
import { getStripeClient, stripeWebhookSecret, stripeProPriceId } from './billing/stripe';
import { rateLimiter } from './rateLimits';

type RateLimitName = 'mcpRegister' | 'mcpAuthorize' | 'mcpTokenExchange';

async function enforceRateLimit(
  ctx: ActionCtx,
  name: RateLimitName,
  key: string,
  logger: Logger,
): Promise<Response | null> {
  const result = await rateLimiter.limit(ctx, name, { key });
  if (result.ok) return null;
  logger.warn('convex.rate_limited', {
    route: name,
    keyClass: 'ip',
    retryAfterMs: result.retryAfter,
  });
  const retryAfterSec = Math.max(1, Math.ceil(result.retryAfter / 1000));
  return new Response(
    JSON.stringify({ error: 'rate_limited', error_description: 'Too many requests' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
      },
    },
  );
}

function getClientIp(request: Request): string {
  // Only trust `cf-connecting-ip` — Cloudflare injects it and clients can't set
  // it. `x-forwarded-for` is client-controlled and trivially spoofable, which
  // would let a caller cycle their rate-limit key at will.
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
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

  // OAuth: Dynamic Client Registration (RFC 7591)
  app.post('/mcp/register', async (c) => {
    const ctx = c.env;
    const logger = getRequestLogger(c.req.raw, { operation: 'mcp_register' });

    const limited = await enforceRateLimit(ctx, 'mcpRegister', getClientIp(c.req.raw), logger);
    if (limited) {
      await logger.flush();
      return limited;
    }

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

    const redirectUris = body.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description: 'At least one redirect_uri is required',
        },
        400,
      );
    }

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
    const logger = getRequestLogger(c.req.raw, { operation: 'mcp_authorize' });

    const limited = await enforceRateLimit(ctx, 'mcpAuthorize', getClientIp(c.req.raw), logger);
    if (limited) {
      await logger.flush();
      return limited;
    }

    const url = new URL(c.req.url);
    const clientState = url.searchParams.get('state') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri');
    const codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? undefined;

    if (!redirectUri) {
      return c.json({ error: 'redirect_uri is required' }, 400);
    }

    const callbackUrl = new URL('/mcp/callback', url.origin).toString();

    const state = await oauth.signState({
      clientState,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
    });

    const auth0Url = oauth.buildAuth0AuthorizeUrl(state, callbackUrl);

    // Return HTML redirect page as fallback for browsers that might not follow 302 immediately
    const redirectHtml = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=${auth0Url}">
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to authentication... <a href="${auth0Url}">Click here if not redirected</a></p>
  <script>window.location.href = "${auth0Url}";</script>
</body>
</html>`;

    return new Response(redirectHtml, {
      status: 302,
      headers: {
        Location: auth0Url,
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

      // Create authorization code (for code exchange at token endpoint)
      const authCode = await ctx.runMutation(internal.mcp.tokens.createAuthCode, {
        userId,
        redirectUri: statePayload.redirectUri,
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

    const limited = await enforceRateLimit(ctx, 'mcpTokenExchange', getClientIp(c.req.raw), logger);
    if (limited) {
      await logger.flush();
      return limited;
    }

    const body = await c.req.parseBody();
    const grantType = body.grant_type;

    if (grantType === 'authorization_code') {
      const code = body.code as string;
      const redirectUri = body.redirect_uri as string;
      const codeVerifier = body.code_verifier as string | undefined;

      if (!code) {
        return c.json({ error: 'invalid_request', error_description: 'code is required' }, 400);
      }

      if (!redirectUri) {
        return c.json(
          { error: 'invalid_request', error_description: 'redirect_uri is required' },
          400,
        );
      }

      const result = await ctx.runMutation(internal.mcp.tokens.exchangeAuthCode, {
        code,
        redirectUri,
        codeVerifier,
      });

      if ('error' in result) {
        return c.json(result, 400);
      }

      const accessToken = await tokens.createAccessToken(result.userId, result.tokenId);

      return c.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: tokens.ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: result.tokenId,
      });
    }

    if (grantType === 'refresh_token') {
      const refreshTokenId = body.refresh_token as string;

      if (!refreshTokenId) {
        return c.json(
          { error: 'invalid_request', error_description: 'refresh_token is required' },
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

      // Refresh Auth0 token if we have one
      if (refreshToken.auth0RefreshToken) {
        try {
          const newAuth0Tokens = await oauth.refreshAuth0Token(refreshToken.auth0RefreshToken);

          if (newAuth0Tokens.refresh_token) {
            await ctx.runMutation(internal.mcp.tokens.updateRefreshToken, {
              tokenId: refreshTokenId,
              auth0RefreshToken: newAuth0Tokens.refresh_token,
            });
          }
        } catch (err) {
          logger.error('convex.auth0_token_refresh_failed', err);
        }
      }

      const accessToken = await tokens.createAccessToken(refreshToken.userId, refreshTokenId);

      await logger.flush();
      return c.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: tokens.ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshTokenId,
      });
    }

    return c.json(
      { error: 'unsupported_grant_type', error_description: 'Unsupported grant_type' },
      400,
    );
  });

  // MCP: Protocol endpoint
  app.post('/mcp', async (c) => {
    const ctx = c.env;

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const payload = await tokens.validateAccessToken(token);

    if (!payload) {
      return c.json({ error: 'Invalid or expired access token' }, 401);
    }

    // Verify user exists and is enabled
    const user = await ctx.runQuery(internal.auth.users.getUserById, {
      id: payload.userId as Id<'users'>,
    });
    if (!user) {
      return c.json({ error: 'User not found' }, 401);
    }

    if (!user.enabled) {
      return c.json({ error: 'User account is not enabled' }, 403);
    }

    const sessionId = c.req.header('Mcp-Session-Id') ?? undefined;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: Invalid JSON' },
        },
        400,
      );
    }

    const result = await ctx.runAction(internal.mcp.handler.handleMessageWithUser, {
      message: body,
      sessionId,
      userId: user._id,
    });

    if (result === null) {
      return c.body(null, 204);
    }

    if (result.result && typeof result.result === 'object' && 'sessionId' in result.result) {
      c.header('Mcp-Session-Id', (result.result as { sessionId: string }).sessionId);
    }

    return c.json(result);
  });

  // Usage: DO pushes usage totals
  app.post('/usage/record', async (c) => {
    const ctx = c.env;
    const requestTraceContext = traceContextFromHeaders(c.req.raw.headers);

    const authHeader = c.req.header('Authorization');
    const secret = process.env.USAGE_SYNC_SECRET;
    if (!secret || authHeader !== `Bearer ${secret}`) {
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

    const orgId = body.orgId as Id<'organizations'>;

    // Verify the org exists before recording usage
    const org = await ctx.runQuery(internal.auth.organizations.getByIdInternal, { id: orgId });
    if (!org) {
      logger.warn('convex.usage_org_not_found');
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

  // MCP: Terminate session
  app.delete('/mcp', async (c) => {
    const ctx = c.env;

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const payload = await tokens.validateAccessToken(token);

    if (!payload) {
      return c.json({ error: 'Invalid or expired access token' }, 401);
    }

    const sessionId = c.req.header('Mcp-Session-Id');
    if (!sessionId) {
      return c.json({ error: 'Missing Mcp-Session-Id header' }, 400);
    }

    const session = await ctx.runQuery(internal.mcp.session.getSessionInternal, { sessionId });
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (session.userId !== payload.userId) {
      return c.json({ error: 'Session does not belong to this user' }, 403);
    }

    await ctx.runMutation(internal.mcp.session.updateSessionState, {
      sessionId,
      state: 'shutdown' as const,
    });
    await ctx.runMutation(internal.mcp.session.deleteSession, { sessionId });

    return c.body(null, 204);
  });

  return app;
}

// Production export (unchanged behavior)
export default new HttpRouterWithHono(createApp());
