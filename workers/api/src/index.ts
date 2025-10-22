import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  STORAGE: R2Bucket;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/bodies/:traceId', async (c) => {
  const traceId = c.req.param('traceId');

  if (!traceId) {
    return c.json({ error: 'Missing traceId' }, 400);
  }

  const requestKey = `requests/${traceId}`;
  const responseKey = `responses/${traceId}`;

  const [requestObject, responseObject] = await Promise.all([
    c.env.STORAGE.get(requestKey),
    c.env.STORAGE.get(responseKey),
  ]);

  const requestBody = requestObject ? await requestObject.text() : null;
  const responseBody = responseObject ? await responseObject.text() : null;

  return c.json({
    requestBody,
    responseBody,
  });
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
