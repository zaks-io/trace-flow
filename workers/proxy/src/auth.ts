import type { Context } from 'hono';

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
      500,
    );
  }

  return null;
}
