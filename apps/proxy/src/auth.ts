import type { Context } from 'hono';
import type { Logger } from '@trace-flow/logging';
import type { SubscriptionKVData } from '@trace-flow/types';
import { sha256Hex } from '@trace-flow/utils';
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
  logger?: Logger,
): Promise<Response | ApiKeyData> {
  const apiKey = c.req.header('X-Trace-Flow-Api-Key');

  if (!apiKey) {
    logger?.warn('proxy.auth_rejected', { reason: 'missing_key', path: c.req.path });
    return c.json(
      {
        error: 'Missing API key',
        message: 'Please provide an API key via X-Trace-Flow-Api-Key header',
      },
      401,
    );
  }

  // Cache the parsed ApiKeyData (not the raw JSON string) to skip JSON.parse on hits.
  // Corrupt/missing keys resolve to null. Expired keys are cached, then invalidated on first access.
  const cacheKey = `apikey:${await sha256Hex(apiKey)}`;
  const parsed = await getCached<ApiKeyData | null>(cacheKey, async () => {
    const raw = await c.env.API_KEYS.get(apiKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ApiKeyData;
    } catch {
      return null;
    }
  });

  if (!parsed) {
    logger?.warn('proxy.auth_rejected', { reason: 'invalid_key', path: c.req.path });
    return c.json(
      {
        error: 'Invalid API key',
        message: 'The provided API key is not valid',
      },
      401,
    );
  }

  if (parsed.expiresAt < Date.now()) {
    await invalidate(cacheKey);
    logger?.warn('proxy.auth_rejected', { reason: 'expired_key', path: c.req.path });
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
  status: 'active' | 'grace' | 'suspended' | 'canceled' | 'not_found';
  subscription?: SubscriptionKVData;
}

export async function checkBillingStatus(
  env: { API_KEYS: KVNamespace },
  orgId: string,
  logger?: Logger,
): Promise<BillingCheckResult> {
  // Cache the parsed BillingCheckResult (not the raw JSON string).
  // Corrupt or unrecognized data resolves to null so it isn't cached as valid.
  return getCached<BillingCheckResult>(`billing:${orgId}`, async () => {
    const subRaw = await env.API_KEYS.get(`sub:${orgId}`);
    if (!subRaw) {
      return { status: 'not_found' };
    }

    let sub: SubscriptionKVData;
    try {
      sub = JSON.parse(subRaw) as SubscriptionKVData;
    } catch {
      logger?.error('proxy.billing_data_invalid', undefined, { orgId, reason: 'parse_error' });
      return { status: 'not_found' };
    }

    if (
      sub.status === 'active' ||
      sub.status === 'grace' ||
      sub.status === 'suspended' ||
      sub.status === 'canceled'
    ) {
      return { status: sub.status, subscription: sub };
    }

    logger?.error('proxy.billing_data_invalid', undefined, { orgId, status: sub.status });
    return { status: 'not_found' };
  });
}
