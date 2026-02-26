import type { Context } from 'hono';
import type { SubscriptionKVData } from '@trace-flow/types';

export interface ApiKeyData {
  expiresAt: number;
  createdAt: number;
  orgId: string;
}

/**
 * Validates API keys from KV namespace using the X-Trace-Flow-Api-Key header.
 *
 * Returns an error Response if validation fails, or ApiKeyData if the key is valid.
 */
export async function validateApiKey<E extends { API_KEYS: KVNamespace }>(
  c: Context<{ Bindings: E }>,
): Promise<Response | ApiKeyData> {
  const apiKey = c.req.header('X-Trace-Flow-Api-Key');

  if (!apiKey) {
    return c.json(
      {
        error: 'Missing API key',
        message: 'Please provide an API key via X-Trace-Flow-Api-Key header',
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
    const parsed = JSON.parse(keyData) as ApiKeyData;

    if (parsed.expiresAt < Date.now()) {
      return c.json(
        {
          error: 'Expired API key',
          message: 'The provided API key has expired',
        },
        401,
      );
    }

    return parsed;
  } catch {
    return c.json(
      {
        error: 'Invalid API key data',
        message: 'The API key data is corrupted',
      },
      401,
    );
  }
}

export function isAuthError(result: Response | ApiKeyData): result is Response {
  return result instanceof Response;
}

export interface BillingCheckResult {
  status: 'active' | 'grace' | 'suspended' | 'canceled' | 'not_found' | 'error';
  subscription?: SubscriptionKVData;
}

export async function checkBillingStatus(
  env: { API_KEYS: KVNamespace },
  orgId: string,
): Promise<BillingCheckResult> {
  const subRaw = await env.API_KEYS.get(`sub:${orgId}`);
  if (!subRaw) {
    return { status: 'not_found' };
  }

  let sub: SubscriptionKVData;
  try {
    sub = JSON.parse(subRaw) as SubscriptionKVData;
  } catch {
    console.error('Failed to parse subscription KV data', { orgId });
    return { status: 'error' };
  }

  if (
    sub.status === 'active' ||
    sub.status === 'grace' ||
    sub.status === 'suspended' ||
    sub.status === 'canceled'
  ) {
    return { status: sub.status, subscription: sub };
  }

  console.error('Unrecognized billing status in KV', { orgId, status: sub.status });
  return { status: 'error' };
}
