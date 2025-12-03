import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { validateAuth0JWT } from './auth';

interface Env {
  STORAGE: R2Bucket;
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
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

app.get('/bodies/:traceId/:type', async (c) => {
  const authError = await validateAuth0JWT(c);
  if (authError) {
    return authError;
  }

  const traceId = c.req.param('traceId');
  const type = c.req.param('type');

  if (!traceId) {
    return c.json({ error: 'Missing traceId' }, 400);
  }

  if (type !== 'request' && type !== 'response') {
    return c.json({ error: 'Invalid type. Must be "request" or "response"' }, 400);
  }

  const key = `${type}s/${traceId}`;
  const object = await c.env.STORAGE.get(key);

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

export default app;
