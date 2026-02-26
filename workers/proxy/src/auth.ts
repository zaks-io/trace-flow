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

export async function validateOrgBillingStatus<E extends { API_KEYS: KVNamespace }>(
  c: Context<{ Bindings: E }>,
  orgId: string,
): Promise<Response | null> {
  const subRaw = await c.env.API_KEYS.get(`sub:${orgId}`);
  if (!subRaw) {
    return c.json(
      {
        error: 'Subscription not found',
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'Organization subscription is not configured.',
      },
      500,
    );
  }

  let sub: SubscriptionKVData;
  try {
    sub = JSON.parse(subRaw) as SubscriptionKVData;
  } catch {
    return c.json(
      {
        error: 'Invalid subscription config',
        code: 'SUBSCRIPTION_CONFIG_INVALID',
        message: 'Organization subscription is misconfigured.',
      },
      500,
    );
  }

  if (sub.status === 'active' || sub.status === 'grace') {
    return null;
  }

  if (sub.status === 'suspended') {
    return c.json(
      {
        error: 'Account suspended',
        code: 'ACCOUNT_SUSPENDED',
        message:
          'Your organization is suspended due to a billing issue. Update your payment method in billing settings.',
      },
      402,
    );
  }

  if (sub.status === 'canceled') {
    return c.json(
      {
        error: 'Account canceled',
        code: 'ACCOUNT_CANCELED',
        message: 'This organization subscription has been canceled. Contact support to reactivate.',
      },
      402,
    );
  }

  return c.json(
    {
      error: 'Unknown billing status',
      code: 'BILLING_STATUS_UNKNOWN',
      message: 'Organization billing status is unrecognized. Contact support.',
    },
    402,
  );
}
