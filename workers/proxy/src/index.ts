/**
 * LLM Proxy Worker - Streams LLM responses while capturing request/response data for observability.
 *
 * Architecture:
 * 1. Receives client request at `/{provider}/*` endpoint (e.g., /openai/v1/chat/completions)
 * 2. Routes to the correct provider base URL based on path prefix (OpenAI, Anthropic, OpenRouter, Groq)
 * 3. Duplicates request body using tee() - one stream for proxying, one for capture
 * 4. Proxies request to target provider and streams response back to client immediately (low latency)
 * 5. Simultaneously captures response chunks using TransformStream while streaming to client
 * 6. Asynchronously stores bodies in R2 and enqueues metadata for processing (via waitUntil)
 *
 * The waitUntil pattern is critical: storage and queueing happen after the client response completes,
 * ensuring the proxy never blocks the client for observability operations.
 *
 * SSE streaming responses (text/event-stream) receive special handling to extract timing metrics
 * for streaming-specific events (message_start, content_block_delta, etc).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import {
  generateId,
  generateTraceId,
  getCurrentTimestamp,
  validateTraceId,
  validateSpanId,
} from '@trace-flow/utils';
import type {
  SSEStreamData,
  QueueMessageUnion,
  LLMResponseMetadata,
  InputMessage,
} from '@trace-flow/types';
import { validateApiKey } from './auth';
import { parseTokenUsage } from './parsers/tokens';
import { parseError } from './parsers/errors';
import { extractMetadataFromResponseBody } from './parsers/metadata-regex';
import { parseAnthropicRequestBody, parseOpenAIStyleRequestBody } from './parsers/request-body';
import { captureStream, createResponseCapture, chunksToString } from './streaming/capture';
import { createSSEParser, aggregateSSETokens } from './streaming/sse';
import { storeRequestResponse } from './storage';
import { createQueueMessage } from './queue';
import { resolveRoute, PROVIDERS } from './providers';
import { handleOTLPTraces } from './otlp';
import { otlpTracesRoute } from './otlp/routes';
interface Env {
  REQUEST_QUEUE: Queue<QueueMessageUnion>;
  STORAGE: R2Bucket;
  API_KEYS: KVNamespace;
}

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use('*', cors());

// Register security scheme for API key authentication
app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
  type: 'apiKey',
  in: 'header',
  name: 'X-Trace-Flow-Api-Key',
  description: 'API key for authentication. Obtain from your Trace Flow dashboard.',
});

// OpenAPI spec endpoint
app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Trace Flow API',
    version: '1.0.0',
    description: 'OpenTelemetry trace ingestion API for observability and analytics.',
  },
  servers: [{ url: 'https://trace-flow.dev', description: 'Production' }],
  tags: [
    {
      name: 'Traces',
      description: 'OpenTelemetry trace ingestion endpoints',
    },
  ],
  security: [{ apiKey: [] }],
});

// OTLP trace ingestion endpoint - must be before catch-all proxy handler
app.post('/v1/traces', handleOTLPTraces);

// Register the route definition for OpenAPI spec generation
app.openAPIRegistry.registerPath(otlpTracesRoute);

app.all('*', async (c) => {
  const authError = await validateApiKey(c);
  if (authError) {
    return authError;
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

  const route = resolveRoute(c.req.path);
  if (!route) {
    return c.json(
      {
        error: 'Invalid route',
        message: `Use /{provider}/... where provider is one of: ${Object.keys(PROVIDERS).join(', ')}`,
      },
      404,
    );
  }

  const apiKey = c.req.header('X-Trace-Flow-Api-Key') ?? '';
  const requestId = generateId();
  const requestStart = getCurrentTimestamp();

  // Allow user to provide trace context to join existing OTEL traces
  // X-Trace-Flow-Trace-Id: 32 hex chars - joins proxy request to existing trace
  // X-Trace-Flow-Parent-Span-Id: 16 hex chars - sets parent span for hierarchy
  const providedTraceId = validateTraceId(c.req.header('X-Trace-Flow-Trace-Id'));
  const traceId = providedTraceId ?? generateTraceId();
  const parentSpanId = validateSpanId(c.req.header('X-Trace-Flow-Parent-Span-Id'));

  const { targetUrl } = route;

  // Duplicate request body stream: one for proxying to provider, one for capture
  // tee() creates two independent readers from the same source without buffering the entire body
  const [streamToProxy, streamToCapture] = c.req.raw.body?.tee() ?? [null, null];

  // Forward all headers except proxy-specific ones
  // Strip X-Trace-Flow-* headers (proxy auth and trace context) and host header
  // All other headers (including Authorization, x-api-key) pass through to provider
  const headers = new Headers(c.req.raw.headers);
  headers.delete('X-Trace-Flow-Api-Key');
  headers.delete('X-Trace-Flow-Trace-Id');
  headers.delete('X-Trace-Flow-Parent-Span-Id');
  headers.delete('host');

  const requestSent = getCurrentTimestamp();

  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: streamToProxy,
  });

  const isSSE = response.headers.get('Content-Type')?.includes('text/event-stream') ?? false;

  const sseStreamData: SSEStreamData = { messages: [] };

  const parser = isSSE ? createSSEParser(sseStreamData) : null;

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

        const responseComplete = getCurrentTimestamp();
        const latency = responseComplete - requestStart;

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

        // Extract tokens from response body (non-streaming) or SSE stream data (streaming)
        // SSE tokens take precedence as they're accumulated throughout the stream
        const parsedTokens = response.status >= 400 ? undefined : parseTokenUsage(responseBody);
        const sseTokens =
          isSSE && sseStreamData.messages.length > 0
            ? aggregateSSETokens(sseStreamData)
            : undefined;
        // Merge tokens: prefer SSE tokens for prompt/completion, but also include any
        // additional fields from parsed tokens (like reasoningTokens, cachedTokens)
        const tokens = sseTokens ? { ...parsedTokens, ...sseTokens } : parsedTokens;
        const error =
          response.status >= 400 ? parseError(responseBody, response.status) : undefined;

        // Extract response metadata
        let responseMetadata: Partial<LLMResponseMetadata> | undefined;
        if (response.status < 400) {
          if (isSSE && sseStreamData.messages.length > 0) {
            // For SSE responses, extract metadata from the last message (accumulated across events)
            const lastMessage = sseStreamData.messages[sseStreamData.messages.length - 1];
            responseMetadata = lastMessage?.metadata;
          } else {
            // For non-streaming responses, extract from response body using regex
            responseMetadata = extractMetadataFromResponseBody(responseBody);
          }
        }

        // Parse input messages based on provider
        const isAnthropic = targetUrl.includes('anthropic.com');
        const isOpenAIStyle =
          targetUrl.includes('openai.com') ||
          targetUrl.includes('groq.com') ||
          targetUrl.includes('openrouter.ai');

        let inputMessages: InputMessage[] | undefined;

        if (requestBody) {
          try {
            if (isAnthropic) {
              inputMessages = parseAnthropicRequestBody(requestBody) ?? undefined;
            } else if (isOpenAIStyle) {
              inputMessages = parseOpenAIStyleRequestBody(requestBody) ?? undefined;
            }
          } catch (error) {
            console.error('Failed to parse request body:', {
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

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
          traceId,
          parentSpanId: parentSpanId ?? undefined,
          apiKey,
          targetUrl,
          responseStatus: response.status,
          requestStart,
          requestSent,
          firstTokenReceived,
          responseComplete,
          latency,
          requestBodyKey: stored ? requestBodyKey : undefined,
          responseBodyKey: stored ? responseBodyKey : undefined,
          tokens,
          error,
          truncated: isTruncated,
          sseStreamData: isSSE && sseStreamData.messages.length > 0 ? sseStreamData : undefined,
          responseMetadata,
          receivedAt: requestStart * 1_000_000,
          inputMessages,
        });

        await c.env.REQUEST_QUEUE.send(queueMessage);
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
