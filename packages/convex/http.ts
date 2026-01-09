import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HttpRouterWithHono } from 'convex-helpers/server/hono';
import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';
import * as oauthModule from './mcp/oauth';
import * as tokensModule from './mcp/tokens';

// Dependencies that can be injected for testing
export interface HttpDeps {
  oauth: typeof oauthModule;
  tokens: typeof tokensModule;
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
        console.error('Auth0 token exchange failed:', err);
        return c.json({ error: 'Auth0 token exchange failed', details: String(err) }, 500);
      }

      // Get user info from Auth0
      let userInfo;
      try {
        userInfo = await oauth.getAuth0UserInfo(auth0Tokens.access_token);
      } catch (err) {
        console.error('Auth0 userinfo failed:', err);
        return c.json({ error: 'Failed to get user info', details: String(err) }, 500);
      }

      if (!userInfo.email) {
        return c.json({ error: 'Email is required' }, 400);
      }

      const domain = process.env.AUTH0_DOMAIN;
      const tokenIdentifier = `https://${domain}/|${userInfo.sub}`;

      // Find or create user
      const userId = await ctx.runMutation(internal.users.findOrCreateUser, {
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
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectUrl.toString(),
          'Content-Length': '0',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    } catch (err) {
      console.error('OAuth callback error:', err);
      return c.json({ error: 'OAuth callback failed', details: String(err) }, 500);
    }
  });

  // OAuth: Token endpoint (for authorization code and refresh)
  app.post('/mcp/token', async (c) => {
    const ctx = c.env;
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
          console.error('Auth0 token refresh failed:', err);
        }
      }

      const accessToken = await tokens.createAccessToken(refreshToken.userId, refreshTokenId);

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
    const user = await ctx.runQuery(internal.users.getUserById, {
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

    const result = await ctx.runAction(api.mcp.handler.handleMessageWithUser, {
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
