import type { Context } from 'hono';
import { jwtVerify, createRemoteJWKSet } from 'jose';

interface JWTPayload {
  iss: string;
  aud: string | string[];
  exp: number;
  'neuron/roles'?: string[];
}

/**
 * Validates Auth0 JWT tokens using JWKS public key verification.
 *
 * Architecture:
 * - Fetches public keys from Auth0's JWKS endpoint for RS256 signature verification
 * - Validates iss (issuer) and aud (audience) claims to prevent token reuse attacks
 * - Checks for 'Observe' role in neuron/roles claim (matches Convex pattern)
 * - Uses jose library's createRemoteJWKSet which handles JWKS caching automatically
 *
 * Returns null on success, or an error Response with appropriate status code.
 */
export async function validateAuth0JWT<E extends { AUTH0_DOMAIN: string; AUTH0_CLIENT_ID: string }>(
  c: Context<{ Bindings: E }>,
): Promise<Response | null> {
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
    console.error('Auth0 configuration is missing', { domain, clientId });
    return c.json(
      {
        error: 'Server configuration error',
        message: 'Auth0 configuration is missing',
      },
      500,
    );
  }

  const jwksUrl = `https://${domain}/.well-known/jwks.json`;

  const JWKS = createRemoteJWKSet(new URL(jwksUrl));

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${domain}/`,
      audience: clientId,
    });

    const roles = (payload as JWTPayload)['neuron/roles'] ?? [];

    if (!roles.includes('Observe')) {
      return c.json(
        {
          error: 'Insufficient permissions',
          message: 'The Observe role is required to access this resource',
        },
        403,
      );
    }

    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('expired')) {
      return c.json(
        {
          error: 'Token expired',
          message: 'The provided JWT has expired',
        },
        401,
      );
    }
    console.error('Error validating Auth0 JWT', error);
    return c.json(
      {
        error: 'Invalid token',
        message: 'JWT verification failed',
      },
      401,
    );
  }
}
