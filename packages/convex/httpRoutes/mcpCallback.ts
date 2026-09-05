import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { HttpDeps } from './deps';
import { isLoopbackRedirect } from './redirectUris';
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
      if (statePayload.clientState.startsWith('archive:')) {
        if (!isLoopbackRedirect(statePayload.redirectUri)) {
          logger.warn('convex.archive_login_bad_redirect');
          await logger.flush();
          return c.json({ error: 'Invalid redirect target' }, 400);
        }

        const org = await ctx.runQuery(internal.collectorLogin.resolveLoginOrg, { userId });
        if (!org) {
          const redirectUrl = new URL(statePayload.redirectUri);
          redirectUrl.searchParams.set('error', 'no_organization');
          redirectUrl.searchParams.set('state', statePayload.clientState.slice('archive:'.length));
          await logger.flush();
          return new Response(null, {
            status: 302,
            headers: { Location: redirectUrl.toString(), 'Cache-Control': 'no-store' },
          });
        }

        const session = await oauth.signArchiveSession({
          userId,
          orgId: org.orgId,
        });
        const redirectUrl = new URL(statePayload.redirectUri);
        redirectUrl.searchParams.set('session', session);
        redirectUrl.searchParams.set('org_id', org.orgId);
        redirectUrl.searchParams.set('user_id', userId);
        redirectUrl.searchParams.set('state', statePayload.clientState.slice('archive:'.length));
        logger.info('convex.archive_session_minted', { org_id: org.orgId });
        await logger.flush();
        return new Response(null, {
          status: 302,
          headers: { Location: redirectUrl.toString(), 'Cache-Control': 'no-store' },
        });
      }

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
}
