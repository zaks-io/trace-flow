import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { HttpDeps } from './deps';
import { BodySizeLimitError } from '@trace-flow/utils';
import { canonicalizeMcpResource } from './redirectUris';
import { getRequestLogger } from './shared';
import { readBoundedText } from './requestBody';
import { isAllowedMcpOAuthHost } from './mcpOAuthHost';
import { isValidCodeVerifier } from './mcpPkce';

const TOKEN_REQUEST_MAX_BYTES = 16 * 1024;

export function registerMcpTokenRoutes(app: HonoWithConvex<ActionCtx>, { tokens }: HttpDeps): void {
  // OAuth: Token endpoint (for authorization code and refresh)
  app.post('/mcp/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    if (!isAllowedMcpOAuthHost(c.req.raw)) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
    const ctx = c.env;
    const logger = getRequestLogger(c.req.raw, {
      operation: 'mcp_token',
    });

    try {
      const contentType = c.req.header('Content-Type')?.toLowerCase() ?? '';
      const mediaType = contentType.split(';', 1)[0]?.trim();
      if (mediaType !== 'application/x-www-form-urlencoded') {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Content-Type must be application/x-www-form-urlencoded',
          },
          415,
        );
      }

      const body = new URLSearchParams(await readBoundedText(c.req.raw, TOKEN_REQUEST_MAX_BYTES));
      const grantType = body.get('grant_type');

      if (grantType === 'authorization_code') {
        const code = body.get('code') ?? undefined;
        const clientId = body.get('client_id') ?? undefined;
        const redirectUri = body.get('redirect_uri') ?? undefined;
        const resource = body.get('resource') ?? undefined;
        const codeVerifier = body.get('code_verifier') ?? undefined;

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
            {
              error: 'invalid_request',
              error_description: 'resource must identify a Trace Flow MCP endpoint',
            },
            400,
          );
        }

        if (!codeVerifier) {
          return c.json(
            { error: 'invalid_request', error_description: 'code_verifier is required' },
            400,
          );
        }
        if (!isValidCodeVerifier(codeVerifier)) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: 'code_verifier must be a valid PKCE verifier',
            },
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
        const rejectRefresh = async (reason: string): Promise<Response> => {
          logger.warn('convex.mcp_refresh_rejected', { reason });
          await logger.flush();
          return c.json(
            { error: 'invalid_grant', error_description: 'Invalid or expired refresh token' },
            400,
          );
        };
        const refreshTokenId = body.get('refresh_token') ?? undefined;
        const clientId = body.get('client_id') ?? undefined;
        const resource = body.get('resource') ?? undefined;

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
            {
              error: 'invalid_request',
              error_description: 'resource must identify a Trace Flow MCP endpoint',
            },
            400,
          );
        }

        const refreshToken = await ctx.runQuery(internal.mcp.tokens.getRefreshToken, {
          tokenId: refreshTokenId,
        });

        if (!refreshToken) {
          return rejectRefresh('unknown_or_expired');
        }

        if (refreshToken.clientId !== clientId || refreshToken.resource !== canonicalResource) {
          return rejectRefresh('client_or_resource_mismatch');
        }

        const rotated = await ctx.runMutation(internal.mcp.tokens.rotateRefreshToken, {
          tokenId: refreshTokenId,
          clientId,
          resource: canonicalResource,
        });

        if ('error' in rotated) {
          return rejectRefresh('rotation_rejected');
        }

        if (rotated.reusedRotatedAt !== undefined) {
          logger.info('convex.mcp_refresh_token_reused_in_grace', {
            rotatedAgoMs: Date.now() - rotated.reusedRotatedAt,
          });
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
      if (err instanceof BodySizeLimitError) {
        return c.json(
          { error: 'invalid_request', error_description: 'Request body is too large' },
          413,
        );
      }
      logger.error('convex.mcp_token_failed', err);
      await logger.flush();
      return c.json({ error: 'server_error', error_description: 'Internal server error' }, 500);
    }
  });
}
