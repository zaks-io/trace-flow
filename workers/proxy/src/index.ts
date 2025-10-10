import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { generateId, getCurrentTimestamp } from '@observe/shared/utils';
import type { QueueMessage } from '@observe/shared/types';

interface Env {
  REQUEST_QUEUE: Queue<QueueMessage>;
  STORAGE: R2Bucket;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.all('*', async (c) => {
  const requestId = generateId();
  const startTime = getCurrentTimestamp();
  const targetUrl = c.req.header('X-Proxy-Target');

  console.log('Incoming Request:', {
    requestId,
    timestamp: startTime,
    method: c.req.method,
    url: c.req.url,
    targetUrl,
    contentType: c.req.header('Content-Type'),
    authorization: c.req.header('Authorization') ? '[PRESENT]' : '[MISSING]',
  });

  if (!targetUrl) {
    return c.json(
      {
        error: 'Missing X-Proxy-Target header',
        message: 'Please provide the target URL in the X-Proxy-Target header',
      },
      400,
    );
  }

  const [streamToProxy, streamToCapture] = c.req.raw.body?.tee() ?? [null, null];

  const headers = new Headers(c.req.raw.headers);
  headers.delete('X-Proxy-Target');
  headers.delete('host');

  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: streamToProxy,
  });

  const endTime = getCurrentTimestamp();
  const latency = endTime - startTime;

  console.log('Response:', {
    requestId,
    status: response.status,
    latency,
    contentType: response.headers.get('Content-Type'),
  });

  const responseCapturedChunks: Uint8Array[] = [];
  const { readable, writable } = new TransformStream<Uint8Array>({
    transform(chunk, controller) {
      responseCapturedChunks.push(chunk);
      controller.enqueue(chunk);
    },
  });

  const pipePromise = response.body?.pipeTo(writable);

  c.executionCtx.waitUntil(
    (async () => {
      const requestBody = await captureStream(streamToCapture);
      await pipePromise;

      const responseBody = new TextDecoder().decode(
        new Uint8Array(responseCapturedChunks.flatMap((chunk) => Array.from(chunk))),
      );

      const queueMessage: QueueMessage = {
        requestId,
        request: {
          id: requestId,
          provider: 'unknown',
          model: 'unknown',
          messages: [],
          timestamp: startTime,
        },
        response: {
          id: requestId,
          provider: 'unknown',
          status: response.status,
          timestamp: endTime,
          latency,
        },
        requestBody,
        responseBody,
      };

      await c.env.REQUEST_QUEUE.send(queueMessage);
      console.log('Queued capture:', {
        requestId,
        requestBodyLength: requestBody.length,
        responseBodyLength: responseBody.length,
      });
    })(),
  );

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

async function captureStream(stream: ReadableStream | null): Promise<string> {
  if (!stream) return '';

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value instanceof Uint8Array) {
      chunks.push(result.value);
    }
  }

  return new TextDecoder().decode(new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))));
}

export default app;
