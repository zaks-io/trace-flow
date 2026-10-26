import { internalTraceHeaders } from '@trace-flow/utils/sentry-tracing';
import { sha256Hex } from '@trace-flow/utils';
import { McpBackendError } from './backend';

export type McpApiKeyAuthorization =
  | { authorized: true; userId: string }
  | { authorized: false; reason: 'invalid' | 'expired' | 'forbidden' };

export const MCP_AUTHORIZATION_TTL_MS = 30_000;
const MAX_AUTHORIZATIONS = 1000;
const authorizations = new Map<string, { userId: string; backend: string; expiresAt: number }>();

export async function authorizeMcpApiKey(
  key: string,
  config: { connectBaseUrl: string; sharedSecret: string },
): Promise<McpApiKeyAuthorization> {
  const digest = await sha256Hex(key);
  const backend = await sha256Hex(JSON.stringify([config.connectBaseUrl, config.sharedSecret]));
  const cached = authorizations.get(digest);
  const startedAt = Date.now();
  if (cached?.backend === backend && startedAt < cached.expiresAt) {
    return { authorized: true, userId: cached.userId };
  }
  authorizations.delete(digest);
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(new URL('/mcp-backend/authorize-api-key', config.connectBaseUrl), {
      method: 'POST',
      headers: internalTraceHeaders({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.sharedSecret}`,
      }),
      body: JSON.stringify({ key }),
      signal,
    });
    if (!response.ok)
      throw new McpBackendError('API key authorization unavailable', response.status);
    body = await response.json();
  } catch {
    throw new McpBackendError('API key authorization unavailable', 503);
  }
  if (typeof body !== 'object' || body === null || !('authorized' in body)) {
    throw new McpBackendError('API key authorization response malformed', 502);
  }
  if (
    body.authorized === true &&
    'userId' in body &&
    typeof body.userId === 'string' &&
    body.userId.length > 0
  ) {
    // Start before the read so backend latency cannot extend the revocation bound.
    const expiresAt = startedAt + MCP_AUTHORIZATION_TTL_MS;
    if (Date.now() < expiresAt) {
      if (authorizations.size >= MAX_AUTHORIZATIONS) {
        authorizations.delete(authorizations.keys().next().value!);
      }
      authorizations.set(digest, { userId: body.userId, backend, expiresAt });
    }
    return { authorized: true, userId: body.userId };
  }
  if (
    body.authorized === false &&
    'reason' in body &&
    (body.reason === 'invalid' || body.reason === 'expired' || body.reason === 'forbidden')
  ) {
    return { authorized: false, reason: body.reason };
  }
  throw new McpBackendError('API key authorization response malformed', 502);
}
