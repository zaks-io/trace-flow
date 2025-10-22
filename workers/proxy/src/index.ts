/**
 * LLM Proxy Worker - Streams LLM responses while capturing request/response data for observability.
 *
 * Architecture:
 * 1. Receives client request with `X-Proxy-Target` header specifying the LLM provider URL
 * 2. Duplicates request body using tee() - one stream for proxying, one for capture
 * 3. Proxies request to target provider and streams response back to client immediately (low latency)
 * 4. Simultaneously captures response chunks using TransformStream while streaming to client
 * 5. Asynchronously stores bodies in R2 and enqueues metadata for processing (via waitUntil)
 *
 * The waitUntil pattern is critical: storage and queueing happen after the client response completes,
 * ensuring the proxy never blocks the client for observability operations.
 *
 * SSE streaming responses (text/event-stream) receive special handling to extract timing metrics
 * for streaming-specific events (message_start, content_block_delta, etc).
 */
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
import { injectProviderAuth } from './providers';

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

  const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
  const MAX_REQUEST_SIZE = 10 * 1024 * 1024;

  if (contentLength > MAX_REQUEST_SIZE) {
    return c.json(
      {
        error: 'Request too large',
        message: `Request body exceeds ${MAX_REQUEST_SIZE / (1024 * 1024)}MB limit`,
      },
      413,
    );
  }

  // Duplicate request body stream: one for proxying to provider, one for capture
  // tee() creates two independent readers from the same source without buffering the entire body
  const [streamToProxy, streamToCapture] = c.req.raw.body?.tee() ?? [null, null];

  // Extract provider API key before stripping headers
  const providerApiKey = c.req.header('X-Provider-Api-Key');

  // Forward all headers except proxy-specific ones
  // Strip ALL proxy authentication headers to prevent credential leakage:
  // - Authorization: used for proxy authentication, never forward to provider
  // - X-API-Key: alternative proxy auth, never forward to provider
  // - X-Proxy-Target: internal routing metadata
  // - X-Provider-Api-Key: used to inject provider auth, don't forward raw
  // - host: must match target provider
  const headers = new Headers(c.req.raw.headers);
  headers.delete('Authorization');
  headers.delete('X-API-Key');
  headers.delete('X-Proxy-Target');
  headers.delete('X-Provider-Api-Key');
  headers.delete('host');

  // Inject provider-specific authentication if X-Provider-Api-Key was provided
  if (providerApiKey) {
    injectProviderAuth(headers, providerApiKey, targetUrl);
  }

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

  // All observability operations happen in waitUntil to avoid blocking the client response
  // This ensures the proxy returns low latency even if R2 storage or queue operations are slow
  // Wrapped in try-catch to ensure proxy never fails due to observability errors
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const requestBody = await captureStream(streamToCapture, MAX_REQUEST_SIZE);
        await pipePromise;

        const responseCapturedChunks = capture.getCapturedChunks();
        const firstTokenReceived = capture.getFirstTokenTime();
        const isTruncated = capture.isTruncated();
        const totalSize = capture.getTotalSize();
        const responseBody = chunksToString(responseCapturedChunks);

        if (isTruncated) {
          console.warn('Response truncated for storage:', {
            requestId,
            totalSize,
            capturedSize: responseBody.length,
          });
        }

        const tokens = response.status >= 400 ? undefined : parseTokenUsage(responseBody);
        const error =
          response.status >= 400 ? parseError(responseBody, response.status) : undefined;

        const { requestBodyKey, responseBodyKey, stored } = await storeRequestResponse(
          c.env.STORAGE,
          requestId,
          requestBody,
          responseBody,
        );

        if (!stored) {
          console.warn('R2 storage failed, queuing message without body keys:', { requestId });
        }

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
          requestBodyKey: stored ? requestBodyKey : undefined,
          responseBodyKey: stored ? responseBodyKey : undefined,
          tokens,
          error,
          truncated: isTruncated,
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
          truncated: isTruncated,
        });
      } catch (error) {
        console.error('Failed to complete observability capture:', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })(),
  );

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

export default app;
