import { PROTECTED_RESOURCE_METADATA_PATH } from '@trace-flow/mcp-core';
import type { Logger } from '@trace-flow/logging';
import { verifyAccessToken } from './auth';
import { authorizeMcpApiKey } from './apiKeyAuth';

const API_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authError(req: Request, message: string, status: number, error?: string): Response {
  const params = [
    `resource_metadata="${new URL(PROTECTED_RESOURCE_METADATA_PATH, req.url).toString()}"`,
  ];
  if (error) params.push(`error="${error}"`);
  if (error === 'insufficient_scope') params.push('scope="mcp:read"');
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(status === 401 || status === 403
        ? { 'WWW-Authenticate': `Bearer ${params.join(', ')}` }
        : {}),
    },
  });
}

export async function authenticate(c: {
  req: { raw: Request; header(name: string): string | undefined };
  env: { CONNECT_BASE_URL: string; MCP_BACKEND_SHARED_SECRET: string };
  get(name: 'logger'): Logger;
}): Promise<{ userId: string } | { error: Response }> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: authError(c.req.raw, 'Missing or invalid Authorization header', 401) };
  }
  const token = authHeader.slice(7);
  const logger = c.get('logger');
  if (API_KEY_PATTERN.test(token)) {
    try {
      const authorization = await authorizeMcpApiKey(token, {
        connectBaseUrl: c.env.CONNECT_BASE_URL,
        sharedSecret: c.env.MCP_BACKEND_SHARED_SECRET,
      });
      if (authorization.authorized) return { userId: authorization.userId };
      logger.warn('mcp.api_key_auth_rejected', { reason: authorization.reason });
      return {
        error:
          authorization.reason === 'forbidden'
            ? authError(
                c.req.raw,
                'This API key does not have MCP read access',
                403,
                'insufficient_scope',
              )
            : authError(c.req.raw, 'Invalid or expired API key', 401, 'invalid_token'),
      };
    } catch {
      logger.error('mcp.api_key_auth_unavailable');
      return { error: authError(c.req.raw, 'API key verification temporarily unavailable', 503) };
    }
  }
  let payload;
  try {
    payload = await verifyAccessToken(
      token,
      c.env.CONNECT_BASE_URL,
      new URL('/mcp', c.req.raw.url).toString(),
      logger,
    );
  } catch {
    return { error: authError(c.req.raw, 'Token verification temporarily unavailable', 503) };
  }
  if (!payload) {
    return { error: authError(c.req.raw, 'Invalid or expired access token', 401, 'invalid_token') };
  }
  return { userId: payload.userId };
}
