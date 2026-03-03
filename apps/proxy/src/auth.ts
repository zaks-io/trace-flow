import type { Context } from 'hono';
import type { SubscriptionKVData } from '@trace-flow/types';
import { getCached, invalidate } from './cache';

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

  // Cache the parsed ApiKeyData (not the raw JSON string) to skip JSON.parse on hits.
  // Already-expired or corrupt keys resolve to null so they aren't cached as valid data.
  const parsed = await getCached<ApiKeyData | null>(`apikey:${apiKey}`, async () => {
    const raw = await c.env.API_KEYS.get(apiKey);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as ApiKeyData;
      // Don't cache already-expired keys — return null so the cache holds "not found"
      if (data.expiresAt < Date.now()) return null;
      return data;
    } catch {
      return null;
    }
  });

  if (!parsed) {
    return c.json(
      {
        error: 'Invalid API key',
        message: 'The provided API key is not valid or has expired',
      },
      401,
    );
  }

  // Re-check expiry on cache hits (key may have expired since it was cached)
  if (parsed.expiresAt < Date.now()) {
    await invalidate(`apikey:${apiKey}`);
    return c.json(
      {
        error: 'Expired API key',
        message: 'The provided API key has expired',
      },
      401,
    );
  }

  return parsed;
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
  const subRaw = await getCached(`sub:${orgId}`, () => env.API_KEYS.get(`sub:${orgId}`));
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
