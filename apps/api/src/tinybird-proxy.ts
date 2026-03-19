import { Hono } from 'hono';
import type { Logger } from '@trace-flow/logging';
import { verifyTinybirdJWT, extractCacheParams } from './tinybird-jwt';
import { buildCacheKey, computeTTL, hashString } from './cache';

interface TinybirdProxyEnv {
  TINYBIRD_API_URL: string;
  TINYBIRD_ADMIN_TOKEN: string;
}

const VALID_PIPE_NAME = /^[a-z_][a-z0-9_]*$/;

export const tinybirdProxy = new Hono<{
  Bindings: TinybirdProxyEnv;
  Variables: { logger: Logger };
}>();

tinybirdProxy.get('/v0/pipes/*', async (c) => {
  const logger = c.get('logger').child({
    component: 'tinybird-proxy',
    operation: 'query_pipe',
  });
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);

  if (!c.env.TINYBIRD_ADMIN_TOKEN) {
    logger.error('api.tinybird_admin_token_missing');
    return c.json({ error: 'Server configuration error' }, 500);
  }

  let cacheParams;
  try {
    const payload = await verifyTinybirdJWT(token, c.env.TINYBIRD_ADMIN_TOKEN);
    cacheParams = extractCacheParams(payload);
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  const url = new URL(c.req.url);
  const segment = url.pathname.slice('/v0/pipes/'.length);
  const pipe = segment.endsWith('.json') ? segment.slice(0, -5) : segment;

  if (!VALID_PIPE_NAME.test(pipe)) {
    return c.json({ error: 'Invalid pipe name' }, 400);
  }

  const ttl = computeTTL(pipe, url.searchParams);

  // Bypass cache for live polling
  if (ttl === 0) {
    const tbResponse = await fetchFromTinybird(c.env.TINYBIRD_API_URL, url, token);
    if (!tbResponse.ok) {
      return handleUpstreamError(c, logger, tbResponse, pipe);
    }
    const body = await tbResponse.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'BYPASS',
      },
    });
  }

  const apiKeysHash = await hashString(cacheParams.apiKeys);
  const cacheKey = buildCacheKey(pipe, apiKeysHash, cacheParams.retentionDays, url.searchParams);
  const cacheUrl = new URL(`https://cache-internal/${cacheKey}`);
  const cacheRequest = new Request(cacheUrl.toString());

  const cache = caches.default;
  const cached = await cache.match(cacheRequest);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.delete('Cache-Control');
    response.headers.set('X-Cache', 'HIT');
    return response;
  }

  const tbResponse = await fetchFromTinybird(c.env.TINYBIRD_API_URL, url, token);
  if (!tbResponse.ok) {
    return handleUpstreamError(c, logger, tbResponse, pipe);
  }

  const body = await tbResponse.text();
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `private, max-age=${ttl}`,
      'X-Cache': 'MISS',
    },
  });

  c.executionCtx.waitUntil(cache.put(cacheRequest, response.clone()));

  return response;
});

const PASSTHROUGH_STATUSES = new Set([400, 403, 404, 429]);

async function handleUpstreamError(
  c: { json: (data: unknown, status: number) => Response },
  logger: Logger,
  tbResponse: Response,
  pipe: string,
): Promise<Response> {
  const detail = await tbResponse.text();
  logger.error('api.tinybird_upstream_error', undefined, {
    status: tbResponse.status,
    pipe,
    detail,
  });
  const status = PASSTHROUGH_STATUSES.has(tbResponse.status)
    ? tbResponse.status
    : tbResponse.status >= 500
      ? 502
      : 400;
  return c.json({ error: 'Upstream query failed' }, status);
}

async function fetchFromTinybird(
  apiUrl: string,
  originalUrl: URL,
  token: string,
): Promise<Response> {
  const tbUrl = new URL(`${apiUrl}${originalUrl.pathname}${originalUrl.search}`);
  return fetch(tbUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
}
