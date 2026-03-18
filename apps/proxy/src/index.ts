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
import * as Sentry from '@sentry/cloudflare';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  generateId,
  generateTraceId,
  getCurrentTimestamp,
  parseTraceparent,
  parseBaggage,
  deriveOperationName,
} from '@trace-flow/utils';
import type {
  SSEStreamData,
  QueueMessageUnion,
  LLMResponseMetadata,
  LLMTokenUsage,
  InputMessage,
  SubscriptionTier,
} from '@trace-flow/types';
import { validateApiKey, isAuthError, checkBillingStatus } from './auth';
import type { ApiKeyData, BillingCheckResult } from './auth';
import { checkUsage, type UsageCheckResult } from './usage';
import { parseTokenUsage } from './parsers/providers';
import { parseError } from './parsers/errors';
import { extractMetadataFromResponseBody } from './parsers/metadata-regex';
import {
  parseAnthropicRequestBody,
  parseOpenAIStyleRequestBody,
  parseGoogleRequestBody,
} from './parsers/request-body';
import { captureStream, createResponseCapture, chunksToString } from './streaming/capture';
import { createSSEParser, aggregateSSETokens } from './streaming/sse';
import { storeBodies } from './storage';
import { createQueueMessage } from './queue';
import { resolveRoute, PROVIDERS } from './providers';
import { handleOTLPTraces } from './otlp';
import { otlpTracesRoute } from './otlp/routes';
export { UsageTracker } from './usage-tracker';

interface TracingDecision {
  record: boolean;
  reason: 'ok' | 'exceeded' | 'suspended' | 'canceled' | 'no_subscription' | 'internal_error';
  tier?: SubscriptionTier;
  periodEnd?: number;
}

function resolveTracingDecision(
  billing: BillingCheckResult,
  usage: UsageCheckResult,
): TracingDecision {
  if (billing.status === 'suspended') return { record: false, reason: 'suspended' };
  if (billing.status === 'canceled') return { record: false, reason: 'canceled' };
  if (billing.status === 'not_found') return { record: false, reason: 'no_subscription' };

  if (usage.status === 'allowed') return { record: true, reason: 'ok', tier: usage.tier };
  if (usage.status === 'exceeded')
    return { record: false, reason: 'exceeded', tier: usage.tier, periodEnd: usage.periodEnd };

  return { record: false, reason: 'internal_error' };
}

interface Env {
  REQUEST_QUEUE: Queue<QueueMessageUnion>;
  STORAGE: R2Bucket;
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
  CONVEX_SITE_URL: string;
  USAGE_SYNC_SECRET: string;
  ANALYTICS: AnalyticsEngineDataset;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
}

const app = new OpenAPIHono<{ Bindings: Env }>();

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
  const authResult = await validateApiKey(c);
  if (isAuthError(authResult)) {
    return authResult;
  }
  const keyData: ApiKeyData = authResult;

  if (!keyData.orgId) {
    return c.json(
      {
        error: 'Misconfigured API key',
        message: 'API key is not associated with an organization',
      },
      403,
    );
  }

  const billing = await checkBillingStatus(c.env, keyData.orgId);

  // Skip DO round-trip when billing is definitively bad
  const skipUsageCheck =
    billing.status === 'suspended' ||
    billing.status === 'canceled' ||
    billing.status === 'not_found';

  const usageCheck: UsageCheckResult = skipUsageCheck
    ? { status: 'error', reason: 'billing_not_active' }
    : await checkUsage(c.env, keyData.orgId, 1, billing.subscription);

  const decision = resolveTracingDecision(billing, usageCheck);

  if (decision.reason === 'internal_error') {
    console.error('Tracing disabled due to internal error — DO or billing check failed', {
      orgId: keyData.orgId,
      billingStatus: billing.status,
      usageStatus: usageCheck.status,
    });
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

  // Parse W3C Trace Context headers
  // traceparent: 00-{trace-id}-{parent-id}-{flags}
  // tracestate: vendor-specific key-value pairs
  // baggage: user-defined context propagated across services
  const traceparent = parseTraceparent(c.req.header('traceparent'));
  const traceId = traceparent?.traceId ?? generateTraceId();
  const parentSpanId = traceparent?.parentId ?? undefined;
  const traceFlags = traceparent?.flags ?? 0x01;
  const traceState = c.req.header('tracestate') ?? '';
  const baggage = parseBaggage(c.req.header('baggage'));
  const omitBody = c.req.header('X-Trace-Flow-Omit-Body') === 'true';

  // Derive gen_ai.operation.name from the API endpoint path
  const operationName = deriveOperationName(c.req.path);

  const query = new URL(c.req.url).search;
  const targetUrl = route.targetUrl + query;

  // Duplicate request body stream: one for proxying to provider, one for capture
  // tee() creates two independent readers from the same source without buffering the entire body
  const [streamToProxy, streamToCapture] = c.req.raw.body?.tee() ?? [null, null];

  // Forward all headers except proxy-specific and trace context ones
  // Strip X-Trace-Flow-Api-Key (proxy auth), W3C trace headers, and host header
  // All other headers (including Authorization, x-api-key) pass through to provider
  const headers = new Headers(c.req.raw.headers);
  headers.delete('X-Trace-Flow-Api-Key');
  headers.delete('X-Trace-Flow-Omit-Body');
  headers.delete('traceparent');
  headers.delete('tracestate');
  headers.delete('baggage');
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

  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

  const capture = createResponseCapture((chunk) => {
    if (isSSE && parser) {
      const text = decoder.decode(chunk, { stream: true });
      parser.feed(text);
    }
  });

  const { readable, writable } = capture.transform;

  const pipePromise = response.body?.pipeTo(writable);

  if (decision.record) {
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const requestBody = await captureStream(streamToCapture, MAX_REQUEST_SIZE);
          await pipePromise;

          // Flush any pending SSE event — some providers (Google) may not send
          // a trailing blank line after the final data: line, leaving the last
          // event (with final token totals) stuck in the parser's buffer
          if (isSSE && parser) {
            parser.feed('\n\n');
          }

          const responseComplete = getCurrentTimestamp();

          // Set messageStop for providers that don't send [DONE] (e.g. Google)
          if (isSSE && sseStreamData.messages.length > 0) {
            const lastMessage = sseStreamData.messages[sseStreamData.messages.length - 1];
            if (lastMessage && !lastMessage.messageStop) {
              lastMessage.messageStop = responseComplete;
            }
          }
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
          // For SSE responses, only use aggregated SSE tokens — running parseTokenUsage on raw
          // SSE text would match partial data from individual events and could leak stale fields.
          let tokens: LLMTokenUsage | undefined;
          if (isSSE && sseStreamData.messages.length > 0) {
            tokens = aggregateSSETokens(sseStreamData, route.provider.id);
          } else if (response.status < 400) {
            tokens = parseTokenUsage(responseBody, route.provider.id);
          }
          const error =
            response.status >= 400 ? parseError(responseBody, response.status) : undefined;

          // Extract response metadata
          let responseMetadata: Partial<LLMResponseMetadata> | undefined;
          if (response.status < 400) {
            if (isSSE && sseStreamData.messages.length > 0) {
              const lastMessage = sseStreamData.messages[sseStreamData.messages.length - 1];
              responseMetadata = lastMessage?.metadata;
            } else {
              responseMetadata = extractMetadataFromResponseBody(responseBody);
            }
          }

          // Parse input messages based on provider
          const isAnthropic = targetUrl.includes('anthropic.com');
          const isGoogle = targetUrl.includes('generativelanguage.googleapis.com');
          const isOpenAIStyle =
            targetUrl.includes('openai.com') ||
            targetUrl.includes('groq.com') ||
            targetUrl.includes('openrouter.ai');

          let inputMessages: InputMessage[] | undefined;

          if (requestBody) {
            try {
              if (isAnthropic) {
                inputMessages = parseAnthropicRequestBody(requestBody) ?? undefined;
              } else if (isGoogle) {
                inputMessages = parseGoogleRequestBody(requestBody) ?? undefined;
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

          const tier = usageCheck.status !== 'error' ? usageCheck.tier : undefined;
          let stored = false;

          if (!omitBody) {
            stored = await storeBodies(
              c.env.STORAGE,
              requestId,
              requestBody,
              responseBody,
              isTruncated,
              keyData.orgId,
            );

            if (!stored) {
              console.warn('R2 storage failed, queuing message without stored bodies:', {
                requestId,
              });
            }
          }

          const queueMessage = createQueueMessage({
            requestId,
            traceId,
            parentSpanId: parentSpanId ?? undefined,
            traceFlags,
            traceState: traceState || undefined,
            baggage: Object.keys(baggage).length > 0 ? baggage : undefined,
            operationName,
            apiKey,
            targetUrl,
            responseStatus: response.status,
            requestStart,
            requestSent,
            firstTokenReceived,
            responseComplete,
            latency,
            tokens,
            error,
            truncated: isTruncated,
            sseStreamData: isSSE && sseStreamData.messages.length > 0 ? sseStreamData : undefined,
            responseMetadata,
            receivedAt: requestStart * 1_000_000,
            inputMessages,
            tier,
            orgId: keyData.orgId,
          });

          // Analytics Engine slot layout:
          // blobs:   provider, status_code, operation, skip_reason, is_sse, model
          // doubles: total_latency_ms, prep_latency_ms, ttfb_ms, is_server_error, total_tokens,
          //          prompt_tokens, completion_tokens, cache_read_tokens, response_size
          // Queries must use sum(_sample_interval) for counts, quantileExactWeighted for percentiles
          c.env.ANALYTICS.writeDataPoint({
            indexes: [keyData.orgId],
            blobs: [
              route.provider.id,
              response.status.toString(),
              operationName ?? '',
              '',
              isSSE ? '1' : '0',
              responseMetadata?.model ?? '',
            ],
            doubles: [
              responseComplete - requestStart,
              requestSent - requestStart,
              firstTokenReceived ? firstTokenReceived - requestSent : 0,
              response.status >= 500 ? 1 : 0,
              tokens?.totalTokens ?? 0,
              tokens?.promptTokens ?? 0,
              tokens?.completionTokens ?? 0,
              tokens?.cacheReadTokens ?? 0,
              totalSize,
            ],
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
  } else {
    // Not recording — cancel the tee'd capture stream to prevent backpressure hanging the proxy
    c.executionCtx.waitUntil(
      (async () => {
        try {
          // Track skipped requests in Analytics Engine
          c.env.ANALYTICS.writeDataPoint({
            indexes: [keyData.orgId],
            blobs: [
              route.provider.id,
              response.status.toString(),
              operationName ?? '',
              decision.reason ?? '',
              isSSE ? '1' : '0',
              '',
            ],
            doubles: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          });
          await streamToCapture?.cancel();
          await pipePromise;
        } catch (error) {
          if (error instanceof Error && error.name !== 'AbortError') {
            console.error('Stream cleanup failed (not recording):', {
              requestId,
              error: error.message,
            });
          }
        }
      })(),
    );
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('X-Trace-Flow-Recording', String(decision.record));
  if (!decision.record) {
    responseHeaders.set('X-Trace-Flow-Recording-Reason', decision.reason);
    if (decision.reason === 'exceeded' && decision.periodEnd) {
      responseHeaders.set('X-Trace-Flow-Period-Reset', new Date(decision.periodEnd).toISOString());
    }
  }

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
});

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 0.1,
  }),
  app,
);
