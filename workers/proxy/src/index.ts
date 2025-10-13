import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { generateId, getCurrentTimestamp } from '@observe/utils';
import type { SSEMessageTiming, SSEMetadata, QueueMessage } from '@observe/types';
import { validateApiKey } from './auth';
import { parseTokenUsage } from './parsers/tokens';
import { parseError } from './parsers/errors';
import { captureStream, createResponseCapture, chunksToString } from './streaming/capture';
import { createSSEParser } from './streaming/sse';
import { storeRequestResponse } from './storage';
import { createQueueMessage } from './queue';

interface Env {
  REQUEST_QUEUE: Queue<QueueMessage>;
  STORAGE: R2Bucket;
  API_KEYS: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.all('*', async (c) => {
  const authError = await validateApiKey(c);
  if (authError) {
    return authError;
  }

  const apiKey =
    c.req.header('Authorization')?.replace('Bearer ', '') ?? c.req.header('X-API-Key') ?? '';
  const requestId = generateId();
  const requestStart = getCurrentTimestamp();
  const targetUrl = c.req.header('X-Proxy-Target');

  console.log('Incoming Request:', {
    requestId,
    timestamp: requestStart,
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

  const requestSent = getCurrentTimestamp();
  const response = await fetch(`${targetUrl}${c.req.path}`, {
    method: c.req.method,
    headers,
    body: streamToProxy,
  });

  const responseComplete = getCurrentTimestamp();
  const latency = responseComplete - requestStart;

  console.log('Response:', {
    requestId,
    status: response.status,
    latency,
    contentType: response.headers.get('Content-Type'),
  });

  const isSSE = response.headers.get('Content-Type')?.includes('text/event-stream') ?? false;

  if (isSSE) {
    console.log('SSE stream detected for request:', requestId);
  }

  const sseMessageTiming: SSEMessageTiming = {};
  const sseMetadata: SSEMetadata = {};

  const parser = isSSE ? createSSEParser(sseMessageTiming, sseMetadata) : null;

  const decoder = new TextDecoder();

  const capture = createResponseCapture((chunk) => {
    if (isSSE && parser) {
      const text = decoder.decode(chunk);
      parser.feed(text);
    }
  });

  const { readable, writable } = capture.transform;

  const pipePromise = response.body?.pipeTo(writable);

  c.executionCtx.waitUntil(
    (async () => {
      const requestBody = await captureStream(streamToCapture);
      await pipePromise;

      const responseCapturedChunks = capture.getCapturedChunks();
      const firstTokenReceived = capture.getFirstTokenTime();
      const responseBody = chunksToString(responseCapturedChunks);

      const tokens = response.status >= 400 ? undefined : parseTokenUsage(responseBody);
      const error = response.status >= 400 ? parseError(responseBody, response.status) : undefined;

      const { requestBodyKey, responseBodyKey } = await storeRequestResponse(
        c.env.STORAGE,
        requestId,
        requestBody,
        responseBody,
      );

      const queueMessage = createQueueMessage({
        requestId,
        apiKey,
        targetUrl,
        responseStatus: response.status,
        requestStart,
        requestSent,
        firstTokenReceived,
        responseComplete: getCurrentTimestamp(),
        latency,
        requestBodyKey,
        responseBodyKey,
        tokens,
        error,
        sseMessageTiming:
          isSSE && Object.keys(sseMessageTiming).length > 0 ? sseMessageTiming : undefined,
        sseMetadata: isSSE && Object.keys(sseMetadata).length > 0 ? sseMetadata : undefined,
      });

      if (isSSE) {
        console.log('SSE Message Timing:', {
          requestId,
          sseMessageTiming: queueMessage.sseMessageTiming,
          sseMetadata: queueMessage.sseMetadata,
        });
      }

      await c.env.REQUEST_QUEUE.send(queueMessage);
      console.log('Successfully queued message:', {
        requestId,
        provider: queueMessage.request.provider,
        targetUrl,
        requestBodyKey,
        responseBodyKey,
        tokens,
        error,
      });
    })(),
  );

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

export default app;
