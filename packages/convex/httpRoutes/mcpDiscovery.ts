import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { JWKS_PATH } from '@trace-flow/mcp-core';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getPublicJwk } from '../mcp/keys';
import { isSecureRedirectUri } from './redirectUris';
import { getRequestLogger } from './shared';

export function registerMcpDiscoveryRoutes(app: HonoWithConvex<ActionCtx>): void {
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
}
