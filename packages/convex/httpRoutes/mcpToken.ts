import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { HttpDeps } from './deps';
import { canonicalizeMcpResource } from './redirectUris';
import { getRequestLogger } from './shared';

function bodyString(
  body: Record<string, string | File | (string | File)[]>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export function registerMcpTokenRoutes(
  app: HonoWithConvex<ActionCtx>,
  { oauth, tokens }: HttpDeps,
): void {
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
}
