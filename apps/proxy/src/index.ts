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
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import {
  generateId,
  generateTraceId,
  getCurrentTimestamp,
  parseTraceparent,
  parseBaggage,
  deriveOperationName,
} from '@trace-flow/utils';
import type { SSEStreamData, QueueMessageUnion } from '@trace-flow/types';
import { validateApiKey, isAuthError, checkBillingStatus } from './auth';
import type { ApiKeyData } from './auth';
import { checkUsage, type UsageCheckResult } from './usage';
import { createResponseCapture } from './streaming/capture';
import { createSSEParser } from './streaming/sse';
import { resolveRoute, PROVIDERS } from './providers';
import { handleOTLPTraces } from './otlp';
import { otlpTracesRoute } from './otlp/routes';
import { resolveTracingDecision } from './tracing-decision';
import { captureAndEnqueue, cleanupSkippedCapture } from './capture';
import { buildProxyResponse } from './response';
export { UsageTracker } from './usage-tracker';

interface Env {
  REQUEST_QUEUE: Queue<QueueMessageUnion>;
  STORAGE: R2Bucket;
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
  CONVEX_SITE_URL: string;
  USAGE_SYNC_SECRET: string;
  ANALYTICS: AnalyticsEngineDataset;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
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
  const requestLogger = createWorkerLogger({
    service: 'proxy',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: { component: 'gateway' },
  });

  const authResult = await validateApiKey(c, requestLogger);
  if (isAuthError(authResult)) {
    c.executionCtx.waitUntil(requestLogger.flush());
    return authResult;
  }
  const keyData: ApiKeyData = authResult;

  if (!keyData.orgId) {
    requestLogger.warn('proxy.request_rejected', { reason: 'no_org' });
    c.executionCtx.waitUntil(requestLogger.flush());
    return c.json(
      {
        error: 'Misconfigured API key',
        message: 'API key is not associated with an organization',
      },
      403,
    );
  }

  // Attach orgId to all subsequent logs for this request
  const orgLogger = requestLogger.child({ orgId: keyData.orgId });

  const billing = await checkBillingStatus(c.env, keyData.orgId, orgLogger);

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
    orgLogger.error('proxy.tracing_disabled', undefined, {
      billingStatus: billing.status,
      usageStatus: usageCheck.status,
    });
  }

  const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
  const MAX_REQUEST_SIZE = 10 * 1024 * 1024;

  if (contentLength > MAX_REQUEST_SIZE) {
    orgLogger.warn('proxy.request_rejected', {
      reason: 'too_large',
      contentLength,
    });
    c.executionCtx.waitUntil(orgLogger.flush());
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
    orgLogger.warn('proxy.request_rejected', {
      reason: 'invalid_route',
      path: c.req.path,
    });
    c.executionCtx.waitUntil(orgLogger.flush());
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
  const logger = orgLogger.child({
    traceId,
    requestId,
    parentSpanId,
    provider: route.provider.id,
    operation: operationName,
  });

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

  const responseReceived = getCurrentTimestamp();

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
      captureAndEnqueue({
        env: c.env,
        logger,
        keyData,
        usageCheck,
        requestId,
        traceId,
        parentSpanId,
        traceFlags,
        traceState,
        baggage,
        operationName,
        apiKey,
        route,
        targetUrl,
        streamToCapture,
        response,
        capture,
        isSSE,
        sseStreamData,
        parser,
        pipePromise,
        requestStart,
        requestSent,
        responseReceived,
        omitBody,
        maxRequestSize: MAX_REQUEST_SIZE,
      }),
    );
  } else {
    // Not recording — cancel the tee'd capture stream to prevent backpressure hanging the proxy
    c.executionCtx.waitUntil(
      cleanupSkippedCapture({
        env: c.env,
        logger,
        keyData,
        route,
        response,
        operationName,
        decision,
        isSSE,
        streamToCapture,
        pipePromise,
      }),
    );
  }

  return buildProxyResponse(readable, response, decision);
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
