import type { Context } from 'hono';

/**
 * Validates API keys from KV namespace using the X-Observe-Api-Key header.
 *
 * This header is used exclusively for proxy authentication, allowing Authorization
 * and X-API-Key headers to pass through to LLM providers unchanged.
 *
 * Stored key data includes expiration timestamps to support key rotation.
 * Returns an error Response if validation fails, or null if the key is valid (null = success).
 */
export async function validateApiKey<E extends { API_KEYS: KVNamespace }>(
  c: Context<{ Bindings: E }>,
): Promise<Response | null> {
  const apiKey = c.req.header('X-Observe-Api-Key');

  if (!apiKey) {
    return c.json(
      {
        error: 'Missing API key',
        message: 'Please provide an API key via X-Observe-Api-Key header',
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
