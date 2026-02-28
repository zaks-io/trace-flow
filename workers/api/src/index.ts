import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { RETENTION_DAYS, type SubscriptionKVData } from '@trace-flow/types';
import { validateAuth0JWT } from './auth';

interface Env {
  STORAGE: R2Bucket;
  API_KEYS: KVNamespace;
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
}

const PRODUCTION_ORIGINS = [
  'https://trace-flow.dev',
  'https://trace-flow-web-dev.isaac-a46.workers.dev',
];

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:8788'];

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const isDev = c.env.SENTRY_ENVIRONMENT !== 'production';
  const allowed = isDev ? [...PRODUCTION_ORIGINS, ...DEV_ORIGINS] : PRODUCTION_ORIGINS;
  const mw = cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return mw(c, next);
});

app.get('/bodies/:requestId/:type', async (c) => {
  const authError = await validateAuth0JWT(c);
  if (authError) {
    return authError;
  }

  const requestId = c.req.param('requestId');
  const type = c.req.param('type');

  if (!requestId) {
    return c.json({ error: 'Missing requestId' }, 400);
  }

  if (type !== 'request' && type !== 'response') {
    return c.json({ error: 'Invalid type. Must be "request" or "response"' }, 400);
  }

  // Check edge cache (per-datacenter, post-auth)
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // Try all possible key formats in parallel: tier-prefixed (new) and legacy
  const [pro, hobby, legacy] = await Promise.all([
    c.env.STORAGE.get(`${type}s/pro/${requestId}`),
    c.env.STORAGE.get(`${type}s/hobby/${requestId}`),
    c.env.STORAGE.get(`${type}s/${requestId}`),
  ]);
  const object = pro ?? hobby ?? legacy;

  if (!object) {
    return c.json({ error: `${type} body not found` }, 404);
  }

  // Enforce retention based on current subscription tier
  const orgId = object.customMetadata?.orgId;
  if (orgId) {
    const subData = await c.env.API_KEYS.get<SubscriptionKVData>(`sub:${orgId}`, 'json');
    const tier = subData?.tier ?? 'hobby';
    const retentionMs = RETENTION_DAYS[tier] * 86_400_000;
    const expiresAt = object.uploaded.getTime() + retentionMs;

    if (Date.now() > expiresAt) {
      return c.json({ error: 'Body expired under current retention policy' }, 403);
    }
  }

  const response = new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'text/plain',
      'Cache-Control': 'private, max-age=3600',
    },
  });

  c.executionCtx.waitUntil(
    cache.put(cacheKey, response.clone()).catch((err) => {
      console.error('Edge cache put failed:', err);
    }),
  );

  return response;
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 0.1,
  }),
  app,
);
