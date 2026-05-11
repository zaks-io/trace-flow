import type { Context } from 'hono';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { Logger } from '@trace-flow/logging';

interface JWTPayload {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Validates Auth0 JWT tokens using JWKS public key verification.
 *
 * Architecture:
 * - Fetches public keys from Auth0's JWKS endpoint for RS256 signature verification
 * - Validates iss (issuer) and aud (audience) claims to prevent token reuse attacks
 * - Caches JWKS instances per domain to avoid repeated network calls (200-400ms savings)
 * - Uses jose library's createRemoteJWKSet which handles key rotation automatically
 *
 * Org-scoped access is enforced separately via KV (`user-org:{sub}`) and stored object metadata.
 *
 * Returns null on success, or an error Response with appropriate status code.
 */
export async function validateAuth0JWT<
  E extends { AUTH0_DOMAIN: string; AUTH0_CLIENT_ID: string },
  V extends { userSub: string; logger: Logger },
>(c: Context<{ Bindings: E; Variables: V }>): Promise<Response | null> {
  const logger = c.get('logger');
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json(
      {
        error: 'Missing authorization',
        message: 'Please provide an Authorization: Bearer <token> header',
      },
      401,
    );
  }

  const token = authHeader.replace('Bearer ', '');

  if (!token || token === authHeader) {
    return c.json(
      {
        error: 'Invalid authorization format',
        message: 'Authorization header must be in format: Bearer <token>',
      },
      401,
    );
  }

  const domain = c.env.AUTH0_DOMAIN;
  const clientId = c.env.AUTH0_CLIENT_ID;

  if (!domain || !clientId) {
    logger.error('api.auth_config_missing', undefined, { domain, clientId });
    return c.json(
      {
        error: 'Server configuration error',
        message: 'Auth0 configuration is missing',
      },
      500,
    );
  }

  const jwksUrl = `https://${domain}/.well-known/jwks.json`;

  let JWKS = jwksCache.get(jwksUrl);
  if (!JWKS) {
    JWKS = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, JWKS);
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${domain}/`,
      audience: clientId,
    });

    const jwtPayload = payload as JWTPayload;

    c.set('userSub', jwtPayload.sub);

    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('expired')) {
      logger.warn('api.auth_token_expired');
      return c.json(
        {
          error: 'Token expired',
          message: 'The provided JWT has expired',
        },
        401,
      );
    }
    logger.warn('api.auth_token_invalid', {
      error: errorMessage,
    });
    return c.json(
      {
        error: 'Invalid token',
        message: 'JWT verification failed',
      },
      401,
    );
  }
}
