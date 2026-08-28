import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { axiomConfigFromEnv, createWorkerLogger, type Logger } from '@trace-flow/logging';
import { applySecurityHeaders } from '@trace-flow/utils';
import { buildCacheKey, computeTTL, hashString } from './cache';

interface Env {
  TINYBIRD_API_URL: string;
  PIPES_LIMITER: RateLimit;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
}

interface Variables {
  logger: Logger;
}

const PRODUCTION_ORIGINS = ['https://trace-flow.dev'];
const NON_PROD_ORIGINS = [
  'https://trace-flow-web-dev.isaac-a46.workers.dev',
  'https://trace-flow-web-preview.isaac-a46.workers.dev',
];

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:8788'];
const ALLOWED_BROWSER_HEADERS = ['Content-Type', 'Authorization', 'Baggage', 'Sentry-Trace'];
const EXPOSED_BROWSER_HEADERS = [
  'X-Trace-Flow-Pipe',
  'X-Upstream-Status',
  'X-Tinybird-Request-Id',
  'X-Tinybird-Release',
];
const VALID_PIPE_NAME = /^[a-z_][a-z0-9_]*$/;
const PASSTHROUGH_STATUSES = new Set([400, 401, 403, 404, 429]);
const UPSTREAM_ERROR_BODY_LIMIT = 2048;

export const pipesApp = new Hono<{ Bindings: Env; Variables: Variables }>();

pipesApp.use('*', async (c, next) => {
  const isDev = c.env.SENTRY_ENVIRONMENT !== 'prod';
  const allowed = isDev
    ? [...PRODUCTION_ORIGINS, ...NON_PROD_ORIGINS, ...DEV_ORIGINS]
    : PRODUCTION_ORIGINS;
  const mw = cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ALLOWED_BROWSER_HEADERS,
    exposeHeaders: EXPOSED_BROWSER_HEADERS,
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return mw(c, next);
});

pipesApp.use('*', async (c, next) => {
  await next();
  applySecurityHeaders(c.res.headers);
});

pipesApp.use('*', async (c, next) => {
  const logger = createWorkerLogger({
    service: 'pipes-api',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: {
      component: 'http',
    },
  });
  c.set('logger', logger);
  const start = Date.now();
  await next();
  if (c.req.method !== 'OPTIONS') {
    logger.info('pipes_api.request_complete', {
      status: c.res.status,
      latencyMs: Date.now() - start,
    });
  }
  c.executionCtx.waitUntil(logger.flush());
});

pipesApp.get('/healthz', (c) => c.json({ status: 'ok' }));

pipesApp.get('/v0/pipes/*', async (c) => {
  const logger = c.get('logger').child({
    component: 'tinybird-proxy',
    operation: 'query_pipe',
  });

  const url = new URL(c.req.url);
  const pipe = parsePipeName(url.pathname);
  if (!pipe) {
    return c.json({ error: 'Invalid pipe name' }, 400);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const tokenHash = await hashString(token);
  const limit = await c.env.PIPES_LIMITER.limit({ key: tokenHash });
  if (!limit.success) {
    logger.warn('pipes_api.rate_limited', { route: 'pipes', keyClass: 'pipe_token' });
    return c.json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
  }

  const ttl = computeTTL(pipe, url.searchParams);
  if (ttl === 0) {
    const tbResponse = await fetchFromTinybird(c.env.TINYBIRD_API_URL, url, token);
    if (!tbResponse.ok) {
      return handleUpstreamError(c, logger, tbResponse, pipe);
    }
    return pipeResponse(await tbResponse.text(), 'BYPASS');
  }

  const cacheKey = buildCacheKey(pipe, tokenHash, url.searchParams);
  const cacheRequest = new Request(`https://cache-internal/${cacheKey}`);
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
  // The edge cache refuses to store `Cache-Control: private`, so put a copy
  // with `s-maxage` instead; per-token isolation comes from the cache key.
  c.executionCtx.waitUntil(cache.put(cacheRequest, cacheableCopy(body, ttl)));

  return pipeResponse(body, 'MISS', ttl);
});

pipesApp.notFound((c) => c.json({ error: 'Not found' }, 404));

function parsePipeName(pathname: string): string | null {
  const segment = pathname.slice('/v0/pipes/'.length);
  const pipe = segment.endsWith('.json') ? segment.slice(0, -5) : segment;
  return VALID_PIPE_NAME.test(pipe) ? pipe : null;
}

function pipeResponse(body: string, cacheState: string, ttl?: number): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Cache': cacheState,
  });
  if (ttl !== undefined) {
    headers.set('Cache-Control', `private, max-age=${ttl}`);
    headers.set('Vary', 'Authorization');
  }
  return new Response(body, { status: 200, headers });
}

function cacheableCopy(body: string, ttl: number): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Cache': 'MISS',
      'Cache-Control': `s-maxage=${ttl}`,
    },
  });
}

async function handleUpstreamError(
  c: { json: (data: unknown, status: number) => Response },
  logger: Logger,
  tbResponse: Response,
  pipe: string,
): Promise<Response> {
  const upstreamBody = await readUpstreamErrorBody(tbResponse);
  const tinybirdRequestId = tbResponse.headers.get('x-request-id') ?? undefined;
  const tinybirdRelease = tbResponse.headers.get('x-tb-r') ?? undefined;

  logger.error('pipes_api.tinybird_upstream_error', undefined, {
    status: tbResponse.status,
    pipe,
    tinybirdRequestId,
    tinybirdRelease,
    upstreamBody,
  });

  const status = PASSTHROUGH_STATUSES.has(tbResponse.status)
    ? tbResponse.status
    : tbResponse.status >= 500
      ? 502
      : 400;
  const response = c.json(
    {
      error: 'Upstream query failed',
      pipe,
      upstream_status: tbResponse.status,
      tinybird_request_id: tinybirdRequestId,
      tinybird_release: tinybirdRelease,
      upstream_error: upstreamBody,
    },
    status,
  );

  response.headers.set('X-Trace-Flow-Pipe', pipe);
  response.headers.set('X-Upstream-Status', String(tbResponse.status));
  if (tinybirdRequestId) response.headers.set('X-Tinybird-Request-Id', tinybirdRequestId);
  if (tinybirdRelease) response.headers.set('X-Tinybird-Release', tinybirdRelease);
  return response;
}

async function readUpstreamErrorBody(response: Response): Promise<string> {
  try {
    return truncateAndRedact(await response.text(), UPSTREAM_ERROR_BODY_LIMIT);
  } catch (error) {
    return `Failed to read upstream error body: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function truncateAndRedact(value: string, limit: number): string {
  const redacted = value
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+\b/gi, 'Bearer [redacted]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '[redacted-uuid]',
    );

  if (redacted.length <= limit) {
    return redacted;
  }
  return `${redacted.slice(0, limit)}...[truncated ${redacted.length - limit} chars]`;
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

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
  }),
  pipesApp,
);
