import type { HonoWithConvex } from 'convex-helpers/server/hono';
import { JWKS_PATH } from '@trace-flow/mcp-core';
import { BodySizeLimitError } from '@trace-flow/utils';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getPublicJwk } from '../mcp/keys';
import { isSecureRedirectUri } from './redirectUris';
import { getRequestLogger, isJsonContentType } from './shared';
import { readBoundedJson } from './requestBody';
import { isAllowedMcpOAuthHost } from './mcpOAuthHost';

const CLIENT_REGISTRATION_MAX_BYTES = 32 * 1024;
const CLIENT_NAME_MAX_LENGTH = 200;
const REDIRECT_URI_MAX_LENGTH = 2048;
const REDIRECT_URIS_MAX_COUNT = 10;

export function registerMcpDiscoveryRoutes(app: HonoWithConvex<ActionCtx>): void {
  // OAuth: Discovery metadata (RFC 8414)
  app.get('/.well-known/oauth-authorization-server', (c) => {
    if (!isAllowedMcpOAuthHost(c.req.raw)) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
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
      authorization_response_iss_parameter_supported: true,
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
    if (!isAllowedMcpOAuthHost(c.req.raw)) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
    const ctx = c.env;

    if (!isJsonContentType(c.req.header('Content-Type'))) {
      return c.json(
        {
          error: 'invalid_client_metadata',
          error_description: 'Content-Type must be application/json',
        },
        415,
      );
    }

    let body: unknown;

    try {
      body = await readBoundedJson(c.req.raw, CLIENT_REGISTRATION_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodySizeLimitError) {
        return c.json(
          { error: 'invalid_client_metadata', error_description: 'Request body is too large' },
          413,
        );
      }
      return c.json({ error: 'invalid_client_metadata', error_description: 'Invalid JSON' }, 400);
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Invalid JSON' }, 400);
    }
    const metadata = body as Record<string, unknown>;
    const redirectUris = metadata.redirect_uris;
    const clientName = metadata.client_name;

    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > REDIRECT_URIS_MAX_COUNT ||
      redirectUris.some(
        (uri) =>
          typeof uri !== 'string' ||
          uri.length > REDIRECT_URI_MAX_LENGTH ||
          !isSecureRedirectUri(uri),
      )
    ) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description: 'At least one https or loopback http redirect_uri is required',
        },
        400,
      );
    }

    if (
      clientName !== undefined &&
      (typeof clientName !== 'string' || clientName.length > CLIENT_NAME_MAX_LENGTH)
    ) {
      return c.json(
        {
          error: 'invalid_client_metadata',
          error_description: `client_name must be at most ${CLIENT_NAME_MAX_LENGTH} characters`,
        },
        400,
      );
    }

    const clientId = crypto.randomUUID();

    const registration = await ctx.runMutation(internal.mcp.clients.registerClient, {
      clientId,
      redirectUris,
      clientName,
    });
    if (!registration.ok) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(registration.retryAfter / 1000))));
      return c.json(
        { error: 'temporarily_unavailable', error_description: 'Registration rate limit exceeded' },
        429,
      );
    }

    return c.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: clientName,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });
}
