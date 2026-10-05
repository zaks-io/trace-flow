import {
  _INTERNAL_setSpanForScope,
  createTransport,
  extractTraceparentData,
  propagationContextFromHeaders,
  Scope,
  ServerRuntimeClient,
  SPAN_STATUS_ERROR,
  spanIsSampled,
  startInactiveSpan,
  type Span,
} from '@sentry/core';
import { parseTraceparent, validateSpanId, validateTraceId } from '@trace-flow/utils';
import { validateConvexTraceContext, type ConvexTraceContext } from './traceContext';

export interface ConvexTracingOptions {
  name: string;
  op?: string;
  headers?: Headers;
  traceContext?: ConvexTraceContext;
}

const requestScopes = new WeakMap<Request, Scope>();
const scopeSpans = new WeakMap<Scope, Span>();

export function getRequestSentryScope(request: Request): Scope | undefined {
  return requestScopes.get(request);
}

export function getConvexSentrySpan(scope: Scope): Span | undefined {
  return scopeSpans.get(scope);
}

export function serializeConvexTraceContext(scope?: Scope): ConvexTraceContext | undefined {
  const span = scope && getConvexSentrySpan(scope);
  if (!span) return undefined;
  const context = span.spanContext();
  return { traceId: context.traceId, spanId: context.spanId, sampled: spanIsSampled(span) };
}

function createScope(): Scope {
  const dsn = process.env.SENTRY_DSN;
  const environment = process.env.SENTRY_ENVIRONMENT;
  if (!dsn || !environment) {
    throw new Error('Convex tracing requires SENTRY_DSN and SENTRY_ENVIRONMENT');
  }
  const client = new ServerRuntimeClient({
    dsn,
    environment,
    tracesSampleRate: 1,
    integrations: [],
    stackParser: () => [],
    sendDefaultPii: false,
    transport: (options) =>
      createTransport(options, async (request) => {
        const response = await fetch(options.url, {
          method: 'POST',
          body:
            typeof request.body === 'string' ? request.body : new Uint8Array(request.body).buffer,
          headers: { 'Content-Type': 'application/x-sentry-envelope' },
        });
        await response.arrayBuffer();
        return {
          statusCode: response.status,
          headers: {
            'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
            'retry-after': response.headers.get('retry-after'),
          },
        };
      }),
  });
  const scope = new Scope();
  scope.setClient(client);
  scope.setTag('service', 'convex');
  client.init();
  return scope;
}

function incomingContext(headers: Headers) {
  const sentryTrace = headers.get('sentry-trace');
  const w3c = parseTraceparent(headers.get('traceparent') ?? '');
  const sentry = extractTraceparentData(sentryTrace ?? undefined);
  if (validateTraceId(sentry?.traceId) && validateSpanId(sentry?.parentSpanId)) {
    return propagationContextFromHeaders(sentryTrace!, undefined);
  }
  if (w3c) {
    return propagationContextFromHeaders(
      `${w3c.traceId}-${w3c.parentId}-${w3c.flags & 1 ? '1' : '0'}`,
      undefined,
    );
  }
  return propagationContextFromHeaders(undefined, undefined);
}

export async function withConvexTracing<T>(
  options: ConvexTracingOptions,
  callback: (scope: Scope) => Promise<T>,
): Promise<T> {
  if (options.traceContext) validateConvexTraceContext(options.traceContext);
  // Convex has no async-local Sentry adapter; never hold a global scope across await.
  const scope = createScope();
  if (options.headers) scope.setPropagationContext(incomingContext(options.headers));
  if (options.traceContext) {
    const { traceId, spanId, sampled } = options.traceContext;
    scope.setPropagationContext(
      propagationContextFromHeaders(`${traceId}-${spanId}-${sampled ? '1' : '0'}`, undefined),
    );
  }
  const span = startInactiveSpan({ name: options.name, op: options.op ?? 'function', scope });
  // The pinned SDK exposes this setter for explicit scopes without an async-context adapter.
  _INTERNAL_setSpanForScope(scope, span);
  scopeSpans.set(scope, span);
  try {
    return await callback(scope);
  } catch (error) {
    span.setStatus({ code: SPAN_STATUS_ERROR });
    // Authenticated payloads and backend exceptions can contain credentials or query data.
    scope.captureException(new Error('Convex action failed'));
    throw error;
  } finally {
    span.end();
    // Keep auth responsive with 250 ms per continued export (500 ms nested), accepting telemetry loss.
    const timeoutMs = options.op === 'http.server' || options.traceContext ? 250 : 2000;
    const flushed = await scope.getClient()!.flush(timeoutMs);
    if (!flushed) console.error('convex.sentry_flush_failed');
  }
}

export async function withConvexActionTracing<T>(
  name: string,
  traceContext: ConvexTraceContext | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  if (!traceContext) return callback();
  return withConvexTracing({ name, traceContext }, callback);
}

export async function withConvexHttpTracing<T>(
  request: Request,
  name: string,
  callback: (scope: Scope) => Promise<T>,
): Promise<T> {
  return withConvexTracing({ name, op: 'http.server', headers: request.headers }, async (scope) => {
    requestScopes.set(request, scope);
    try {
      return await callback(scope);
    } finally {
      requestScopes.delete(request);
    }
  });
}
