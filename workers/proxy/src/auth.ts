import type { Context } from 'hono';

/**
 * Validates API keys from KV namespace, supporting two authentication header formats:
 * - `Authorization: Bearer <key>` (standard OAuth-style)
 * - `X-API-Key: <key>` (simple alternative)
 *
 * The dual-header support provides flexibility for different client implementations
 * without requiring complex authentication flows.
 *
 * Stored key data includes expiration timestamps to support key rotation.
 * Returns an error Response if validation fails, or null if the key is valid (null = success).
 */
export async function validateApiKey<E extends { API_KEYS: KVNamespace }>(
  c: Context<{ Bindings: E }>,
): Promise<Response | null> {
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') ?? c.req.header('X-API-Key');

  if (!apiKey) {
    return c.json(
      {
        error: 'Missing API key',
        message: 'Please provide an API key via Authorization: Bearer <key> or X-API-Key header',
      },
      401,
    );
  }

  const keyData = await c.env.API_KEYS.get(apiKey);

  if (!keyData) {
    return c.json(
      {
        error: 'Invalid API key',
        message: 'The provided API key is not valid',
      },
      401,
    );
  }

  try {
    const parsed = JSON.parse(keyData) as { expiresAt: number; createdAt: number };

    if (parsed.expiresAt < Date.now()) {
      return c.json(
        {
          error: 'Expired API key',
          message: 'The provided API key has expired',
        },
        401,
      );
    }
  } catch {
    return c.json(
      {
        error: 'Invalid API key data',
        message: 'The API key data is corrupted',
      },
      401,
    );
  }

  return null;
}
