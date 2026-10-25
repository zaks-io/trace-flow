import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { getCookie } from 'hono/cookie';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { renderCollectorCodePage } from './collectorPages';
import {
  COLLECTOR_CONSENT_COOKIE,
  MCP_CONSENT_COOKIE,
  serializeCollectorConsentCookie,
  serializeMcpConsentCookie,
} from './consentCookies';
import type { HttpDeps } from './deps';
import { staticPageHeaders } from './htmlPage';
import { isLoopbackRedirect, OUT_OF_BAND_REDIRECT } from './redirectUris';
import { getRequestLogger } from './shared';

export function registerMcpCallbackRoutes(
  app: HonoWithConvex<ActionCtx>,
  { oauth }: HttpDeps,
): void {
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

      // Only the browser that approved the consent page holds its nonce cookie, so a sign-in
      // started anywhere else stops here, before the Auth0 code is spent.
      const isCollectorLogin = statePayload.clientState.startsWith('collector:');
      const consentCookie = isCollectorLogin ? COLLECTOR_CONSENT_COOKIE : MCP_CONSENT_COOKIE;
      if (!statePayload.consentNonce || getCookie(c, consentCookie) !== statePayload.consentNonce) {
        logger.warn('convex.oauth_callback_consent_mismatch', { collector: isCollectorLogin });
        await logger.flush();
        return c.json({ error: 'Invalid or expired state' }, 400);
      }

      const callbackUrl = new URL('/mcp/callback', url.origin).toString();

      // Exchange code for Auth0 tokens
      let auth0Tokens;
      try {
        auth0Tokens = await oauth.exchangeAuth0Code(code, callbackUrl);
      } catch (err) {
        logger.error('convex.auth0_token_exchange_failed', err);
        return c.json({ error: 'Auth0 token exchange failed' }, 500);
      }

      // Get user info from Auth0
      let userInfo;
      try {
        userInfo = await oauth.getAuth0UserInfo(auth0Tokens.access_token);
      } catch (err) {
        logger.error('convex.auth0_userinfo_failed', err);
        return c.json({ error: 'Failed to get user info' }, 500);
      }

      if (!userInfo.email) {
        return c.json({ error: 'Email is required' }, 400);
      }
      if (userInfo.email_verified !== true) {
        return c.json({ error: 'A verified email address is required' }, 403);
      }

      const domain = process.env.AUTH0_DOMAIN;
      const tokenIdentifier = `https://${domain}/|${userInfo.sub}`;

      // Find or create user
      let userId;
      try {
        userId = await ctx.runMutation(internal.auth.users.findOrCreateUser, {
          tokenIdentifier,
          email: userInfo.email,
          name: userInfo.name,
          picture: userInfo.picture,
        });
      } catch (error) {
        if (String(error).includes('User account is not enabled')) {
          return c.json({ error: 'User account is not enabled' }, 403);
        }
        throw error;
      }

      // Collector CLI sign-in reuses this registered callback (Auth0 only allows /mcp/callback),
      // tagged by a `collector:` state prefix from /collector/authorize. The redirect target is
      // re-validated, but nothing reserves a loopback port on the browser's machine, where another
      // process may be listening. So a PKCE login gets only a one-time code, redeemed at
      // /collector/token with the verifier the Collector holds. Out-of-band shows that code on a
      // page for the user to paste, with no request to the browser's machine at all.
      if (isCollectorLogin) {
        const codeChallenge =
          statePayload.codeChallengeMethod === 'S256' ? statePayload.codeChallenge : undefined;
        const outOfBand = statePayload.redirectUri === OUT_OF_BAND_REDIRECT;
        if (
          outOfBand ? codeChallenge === undefined : !isLoopbackRedirect(statePayload.redirectUri)
        ) {
          logger.warn('convex.collector_login_bad_redirect', { out_of_band: outOfBand });
          await logger.flush();
          return c.json({ error: 'Invalid redirect target' }, 400);
        }
        const clearConsent = serializeCollectorConsentCookie('', 0);

        if (outOfBand && codeChallenge !== undefined) {
          const code = await ctx.runMutation(internal.collectorLogin.createLoginCode, {
            userId,
            codeChallenge,
          });
          logger.info('convex.collector_login_code_issued', { out_of_band: true });
          await logger.flush();
          return new Response(renderCollectorCodePage(code), {
            status: 200,
            headers: staticPageHeaders(clearConsent),
          });
        }

        const redirectUrl = new URL(statePayload.redirectUri);
        if (codeChallenge !== undefined) {
          const code = await ctx.runMutation(internal.collectorLogin.createLoginCode, {
            userId,
            codeChallenge,
          });
          redirectUrl.searchParams.set('code', code);
          logger.info('convex.collector_login_code_issued', { out_of_band: false });
        } else {
          // Clients from before PKCE get the credential in the redirect.
          const collectorId = `cli-${crypto.randomUUID()}`;
          const minted = await ctx.runMutation(internal.collectorLogin.mintForUser, {
            userId,
            collectorId,
            name: 'Trace Flow CLI',
            platform: 'cli',
          });
          redirectUrl.searchParams.set('secret', minted.secret);
          redirectUrl.searchParams.set('org_id', minted.orgId);
          redirectUrl.searchParams.set('collector_id', collectorId);
          redirectUrl.searchParams.set('convex_url', url.origin);
          logger.info('convex.collector_login_minted', { org_id: minted.orgId });
        }
        // Echo the CLI's one-time state nonce (the part after the `collector:` tag) back to the
        // loopback so the CLI can reject any local request that isn't the callback it initiated.
        redirectUrl.searchParams.set('state', statePayload.clientState.slice('collector:'.length));
        await logger.flush();
        return new Response(null, {
          status: 302,
          headers: {
            Location: redirectUrl.toString(),
            'Cache-Control': 'no-store',
            'Set-Cookie': clearConsent,
          },
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
      redirectUrl.searchParams.set('iss', url.origin);
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
          'Set-Cookie': serializeMcpConsentCookie('', 0),
        },
      });
    } catch (err) {
      logger.error('convex.oauth_callback_failed', err);
      await logger.flush();
      return c.json({ error: 'OAuth callback failed' }, 500);
    }
  });
}
