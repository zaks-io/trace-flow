import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
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
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
}

interface Variables {
  userSub: string;
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
  const start = Date.now();
  await next();
  if (c.req.method !== 'OPTIONS') {
    console.log(
      JSON.stringify({
        type: 'api_request',
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        latencyMs: Date.now() - start,
      }),
    );
  }
});

app.route('/', tinybirdProxy);

app.get('/bodies/:requestId', async (c) => {
  const authError = await validateAuth0JWT(c);
  if (authError) {
    return authError;
  }

  const requestId = c.req.param('requestId');
  const storedBodies = await getStoredBodies(c.env.STORAGE, requestId);
  if (!storedBodies) {
    return c.json({ error: 'Bodies not found' }, 404);
  }

  // Verify the requesting user belongs to the org that owns this object
  const orgId = storedBodies.orgId;
  if (!orgId) {
    // Legacy objects without orgId metadata are inaccessible
    return c.json({ error: 'Forbidden' }, 403);
  }

  const userSub = c.get('userSub');
  const [userOrgData, subData] = await Promise.all([
    userSub ? c.env.API_KEYS.get<{ orgId: string }>(`user-org:${userSub}`, 'json') : null,
    c.env.API_KEYS.get<SubscriptionKVData>(`sub:${orgId}`, 'json'),
  ]);

  if (userOrgData?.orgId !== orgId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const tier = subData?.tier ?? 'hobby';
  if (!isBodyVisible(storedBodies.uploaded, tier)) {
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
