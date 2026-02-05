import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { validateAuth0JWT } from './auth';

interface Env {
  STORAGE: R2Bucket;
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
}

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8788',
  'https://trace-flow.dev',
  'https://trace-flow-web.pages.dev',
  'https://trace-flow-web-preview.pages.dev',
];

const app = new Hono<{ Bindings: Env }>();

app.use(
  '*',
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

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

  // Try tier-prefixed keys first (new format), then fall back to legacy format
  // New format: {type}s/{tier}/{requestId} (e.g., requests/hobby/abc-123)
  // Legacy format: {type}s/{requestId} (e.g., requests/abc-123)
  const tierPrefixes = ['pro', 'hobby'];
  let object: R2ObjectBody | null = null;

  for (const tier of tierPrefixes) {
    const key = `${type}s/${tier}/${requestId}`;
    object = await c.env.STORAGE.get(key);
    if (object) break;
  }

  // Fall back to legacy format if not found with tier prefix
  if (!object) {
    const legacyKey = `${type}s/${requestId}`;
    object = await c.env.STORAGE.get(legacyKey);
  }

  if (!object) {
    return c.json({ error: `${type} body not found` }, 404);
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'text/plain',
    },
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
