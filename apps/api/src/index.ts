import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { axiomConfigFromEnv, createWorkerLogger, type Logger } from '@trace-flow/logging';
import { applySecurityHeaders } from '@trace-flow/utils';
import type { SubscriptionKVData } from '@trace-flow/types';
import { validateAuth0JWT } from './auth';
import { getStoredBodies, isBodyVisible } from './bodies';
import { tinybirdProxy } from './tinybird-proxy';

interface Env {
  STORAGE: R2Bucket;
  API_KEYS: KVNamespace;
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  TINYBIRD_API_URL: string;
  TINYBIRD_ADMIN_TOKEN: string;
  BODIES_LIMITER: RateLimit;
  PIPES_LIMITER: RateLimit;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  BODY_ENCRYPTION_ROOT_KEY?: string;
  BODY_ENCRYPTION_KEY_ID?: string;
  CF_VERSION_METADATA?: { id: string };
}

interface Variables {
  userSub: string;
  logger: Logger;
}

const PRODUCTION_ORIGINS = [
  'https://trace-flow.dev',
  'https://trace-flow-web-dev.isaac-a46.workers.dev',
];

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:8788'];

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

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

app.use('*', async (c, next) => {
  await next();
  applySecurityHeaders(c.res.headers);
});

app.use('*', async (c, next) => {
  const logger = createWorkerLogger({
    service: 'api',
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
    logger.info('api.request_complete', {
      status: c.res.status,
      latencyMs: Date.now() - start,
    });
  }
  c.executionCtx.waitUntil(logger.flush());
});

app.get('/healthz', (c) => c.json({ status: 'ok' }));

app.route('/', tinybirdProxy);

app.get('/bodies/:requestId', async (c) => {
  const logger = c.get('logger');
  const authError = await validateAuth0JWT(c);
  if (authError) {
    return authError;
  }

  const requestId = c.req.param('requestId');
  const requestLogger = logger.child({
    requestId,
    operation: 'fetch_bodies',
  });

  const userSubForLimit = c.get('userSub') ?? c.req.header('cf-connecting-ip') ?? 'unknown';
  const limit = await c.env.BODIES_LIMITER.limit({ key: userSubForLimit });
  if (!limit.success) {
    requestLogger.warn('api.rate_limited', { route: 'bodies', keyClass: 'user' });
    return c.json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
  }
  const storedBodies = await getStoredBodies(c.env.STORAGE, requestId, requestLogger, {
    rootKeyBase64: c.env.BODY_ENCRYPTION_ROOT_KEY,
    keyId: c.env.BODY_ENCRYPTION_KEY_ID,
  });
  if (!storedBodies) {
    requestLogger.warn('api.bodies_not_found');
    return c.json({ error: 'Bodies not found' }, 404);
  }

  // Verify the requesting user belongs to the org that owns this object
  const orgId = storedBodies.orgId;
  if (!orgId) {
    requestLogger.warn('api.bodies_forbidden_missing_org');
    return c.json({ error: 'Forbidden', message: 'Object missing organization metadata' }, 403);
  }

  const userSub = c.get('userSub');
  const [userOrgData, subData] = await Promise.all([
    userSub ? c.env.API_KEYS.get<{ orgId: string }>(`user-org:${userSub}`, 'json') : null,
    c.env.API_KEYS.get<SubscriptionKVData>(`sub:${orgId}`, 'json'),
  ]);

  if (userOrgData?.orgId !== orgId) {
    requestLogger.warn('api.bodies_forbidden_wrong_org', {
      orgId,
      userSub,
      userOrgId: userOrgData?.orgId ?? null,
    });
    return c.json({ error: 'Forbidden', message: 'Organization mismatch' }, 403);
  }

  const tier = subData?.tier ?? 'hobby';
  if (!isBodyVisible(storedBodies.uploaded, tier)) {
    requestLogger.warn('api.bodies_expired', {
      orgId,
      tier,
    });
    return c.json({ error: 'Bodies expired under current retention policy' }, 410);
  }

  return c.json(storedBodies.payload, 200, {
    'Cache-Control': 'private, max-age=3600',
  });
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
