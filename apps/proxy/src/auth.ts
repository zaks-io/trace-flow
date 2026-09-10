import type { Context } from 'hono';
import type { Logger } from '@trace-flow/logging';
import type { SubscriptionKVData } from '@trace-flow/types';
import { analyticsKeyId } from '@trace-flow/utils';
import { getCached } from './cache';

export interface ApiKeyData {
  analyticsKeyId: string;
  expiresAt: number;
  createdAt: number;
  orgId: string;
}

type ApiKeyAuthorization =
  | { authorized: true; expiresAt: number; createdAt: number; orgId: string }
  | { authorized: false; reason: 'invalid' | 'expired' };

async function authorizeApiKey(
  env: { CONVEX_SITE_URL: string; USAGE_SYNC_SECRET: string },
  key: string,
): Promise<ApiKeyAuthorization | null> {
  try {
    const response = await fetch(`${env.CONVEX_SITE_URL}/worker/authorize-api-key`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.USAGE_SYNC_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('authorized' in body)) return null;
    if (
      body.authorized === false &&
      'reason' in body &&
      (body.reason === 'invalid' || body.reason === 'expired')
    ) {
      return { authorized: false, reason: body.reason };
    }
    if (
      body.authorized === true &&
      'expiresAt' in body &&
      typeof body.expiresAt === 'number' &&
      'createdAt' in body &&
      typeof body.createdAt === 'number' &&
      'orgId' in body &&
      typeof body.orgId === 'string'
    ) {
      return {
        authorized: true,
        expiresAt: body.expiresAt,
        createdAt: body.createdAt,
        orgId: body.orgId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validates API keys against current Convex state using the X-Trace-Flow-Api-Key header.
 *
 * Returns an error Response if validation fails, or ApiKeyData if the key is valid.
 */
export async function validateApiKey<
  E extends {
    CONVEX_SITE_URL: string;
    USAGE_SYNC_SECRET: string;
  },
>(c: Context<{ Bindings: E }>, logger?: Logger): Promise<Response | ApiKeyData> {
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

  const identifier = await analyticsKeyId(apiKey);
  const authorization = await authorizeApiKey(c.env, apiKey);
  if (!authorization) {
    logger?.error('proxy.auth_unavailable');
    return c.json(
      {
        error: 'Authentication unavailable',
        message: 'Retry the request',
      },
      503,
      { 'Retry-After': '1' },
    );
  }

  if (!authorization.authorized && authorization.reason === 'invalid') {
    logger?.warn('proxy.auth_rejected', { reason: 'invalid_key', path: c.req.path });
    return c.json(
      {
        error: 'Invalid API key',
        message: 'The provided API key is not valid',
      },
      401,
    );
  }

  if (!authorization.authorized || authorization.expiresAt <= Date.now()) {
    logger?.warn('proxy.auth_rejected', { reason: 'expired_key', path: c.req.path });
    return c.json(
      {
        error: 'Expired API key',
        message: 'The provided API key has expired',
      },
      401,
    );
  }

  return {
    analyticsKeyId: identifier,
    expiresAt: authorization.expiresAt,
    createdAt: authorization.createdAt,
    orgId: authorization.orgId,
  };
}

export function isAuthError(result: Response | ApiKeyData): result is Response {
  return result instanceof Response;
}

interface BillingCheckResult {
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
