import { McpBackendError } from './backend';

export type McpApiKeyAuthorization =
  | { authorized: true; userId: string }
  | { authorized: false; reason: 'invalid' | 'expired' | 'forbidden' };

export async function authorizeMcpApiKey(
  key: string,
  config: { connectBaseUrl: string; sharedSecret: string },
): Promise<McpApiKeyAuthorization> {
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(new URL('/mcp-backend/authorize-api-key', config.connectBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.sharedSecret}`,
      },
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
