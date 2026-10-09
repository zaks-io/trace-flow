import { sentryRequestPrivacy } from '@trace-flow/utils/sentry-tracing';
import * as Sentry from '@sentry/cloudflare';
import {
  BodySizeLimitError,
  readRequestBodyWithLimit,
  TRACE_CONTEXT_HEADERS,
} from '@trace-flow/utils';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { normalizeTraceRequest } from '@trace-flow/utils/ingress-tracing';
import { withNativeTrace } from '@trace-flow/utils/native-tracing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { axiomConfigFromEnv, createWorkerLogger, type Logger } from '@trace-flow/logging';
import {
  JsonRpcErrorCode,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_PATH,
  buildServerCard,
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PATH,
  isRequest,
  isNotification,
  createErrorResponse,
  METHOD_HEADER,
  NAME_HEADER,
  type JsonRpcMessage,
} from '@trace-flow/mcp-core';
import { authenticate } from './authenticate';
import { traceMcpInteraction } from './sentry';
import { handleRpcRequest, requestEra, type RpcOutcome } from './rpc';

interface Env {
  CONNECT_BASE_URL: string;
  TINYBIRD_API_URL: string;
  MCP_BACKEND_SHARED_SECRET: string;
  MCP_SESSION_SECRET: string;
  MCP_LIMITER: RateLimit;
  MCP_REGISTRATION_LIMITER: RateLimit;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
}

interface Variables {
  logger: Logger;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', (c, next) =>
  withNativeTrace((c.executionCtx as ExecutionContext).tracing, 'trace_flow.mcp_request', next),
);

const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';
const MCP_SSE_HEARTBEAT_MS = 15_000;
const MCP_REQUEST_MAX_BYTES = 256 * 1024;
const OAUTH_TOKEN_REQUEST_MAX_BYTES = 16 * 1024;

function hasValidMcpOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

app.use('/mcp', async (c, next) => {
  if (!hasValidMcpOrigin(c.req.raw)) {
    return jsonResponse({ error: 'Forbidden origin' }, 403);
  }
  await next();
});

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Mcp-Session-Id',
      'Mcp-Protocol-Version',
      METHOD_HEADER,
      NAME_HEADER,
      'Baggage',
      'Sentry-Trace',
      'Traceparent',
      'Tracestate',
    ],
    exposeHeaders: ['Mcp-Session-Id'],
    maxAge: 86400,
  }),
);

app.use('*', async (c, next) => {
  const logger = createWorkerLogger({
    service: 'mcp',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: { component: 'http' },
  });
  c.set('logger', logger);
  const start = Date.now();
  await next();
  if (c.error) {
    logger.error('mcp.request_failed', c.error, {
      status: c.res.status,
      latencyMs: Date.now() - start,
    });
  }
  if (c.req.method !== 'OPTIONS') {
    logger.info('mcp.request_complete', {
      status: c.res.status,
      latencyMs: Date.now() - start,
    });
  }
  c.executionCtx.waitUntil(logger.flush());
});

// Trust only cf-connecting-ip; x-forwarded-for is client-spoofable and would let
// a caller cycle their rate-limit key. Matches the Convex side (http.ts).
function getClientIp(req: Request): string | null {
  return req.headers.get('cf-connecting-ip');
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

function mcpResourceUrl(req: Request): string {
  return new URL('/mcp', req.url).toString();
}

async function proxyConnect(
  c: { req: { raw: Request }; env: Env },
  path: string,
): Promise<Response> {
  const url = new URL(path, normalizeOrigin(c.env.CONNECT_BASE_URL));
  const req = new Request(url, c.req.raw);
  for (const header of TRACE_CONTEXT_HEADERS) req.headers.delete(header);
  return fetch(req);
}

async function proxyToken(c: { req: { raw: Request }; env: Env }): Promise<Response> {
  const url = new URL('/mcp/token', normalizeOrigin(c.env.CONNECT_BASE_URL));
  const headers = new Headers(c.req.raw.headers);
  for (const header of TRACE_CONTEXT_HEADERS) headers.delete(header);
  headers.delete('content-length');

  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  const mediaType = contentType.split(';', 1)[0]?.trim();
  if (contentType && mediaType !== 'application/x-www-form-urlencoded') {
    return jsonResponse(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      415,
    );
  }

  let bodyText: string;
  try {
    bodyText = new TextDecoder().decode(
      await readRequestBodyWithLimit(c.req.raw, OAUTH_TOKEN_REQUEST_MAX_BYTES),
    );
  } catch (error) {
    if (error instanceof BodySizeLimitError) {
      return jsonResponse(
        { error: 'invalid_request', error_description: 'Request body is too large' },
        413,
      );
    }
    throw error;
  }
  const body = new URLSearchParams(bodyText);
  if (!body.has('resource')) body.set('resource', mcpResourceUrl(c.req.raw));
  headers.set('content-type', 'application/x-www-form-urlencoded');
  return fetch(url, { method: 'POST', headers, body: body.toString() });
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceIpRateLimit(
  c: {
    req: { raw: Request };
    get(key: 'logger'): Logger;
  },
  limiter: RateLimit,
  surface: 'registration' | 'rpc',
): Promise<Response | null> {
  const logger = c.get('logger');
  const clientIp = getClientIp(c.req.raw);
  if (!clientIp) {
    logger.warn('mcp.client_ip_missing', { surface });
    return jsonResponse({ error: 'Missing client IP' }, 400);
  }

  const limit = await limiter.limit({ key: clientIp });
  if (!limit.success) {
    logger.warn('mcp.rate_limited', { keyClass: 'ip', surface });
    return jsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
  }

  return null;
}

async function enforceMcpRateLimit(c: {
  req: { raw: Request };
  env: Env;
  get(key: 'logger'): Logger;
}): Promise<Response | null> {
  return enforceIpRateLimit(c, c.env.MCP_LIMITER, 'rpc');
}

function mcpSseResponse(c: {
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const streamClosed = writer.closed.then(
    () => true,
    () => true,
  );

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await writer.write(encoder.encode(': connected\n\n'));
        for (;;) {
          const closed = await Promise.race([
            streamClosed,
            delay(MCP_SSE_HEARTBEAT_MS).then(() => false),
          ]);
          if (closed) break;
          await writer.write(encoder.encode(': heartbeat\n\n'));
        }
      } catch {
        // Client closed the receive stream.
      } finally {
        try {
          await writer.close();
        } catch {
          // The stream may already be closed after client disconnect.
        }
      }
    })(),
  );

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

app.get('/healthz', (c) => c.json({ status: 'ok' }));

app.get(PROTECTED_RESOURCE_METADATA_PATH, (c) =>
  c.json(
    buildProtectedResourceMetadata(
      mcpResourceUrl(c.req.raw),
      normalizeOrigin(c.env.CONNECT_BASE_URL),
    ),
  ),
);

// Public, unauthenticated discovery metadata, at the location the spec reserves.
// This copy is origin-derived: it advertises whichever host served it, so a card
// fetched from preview or dev never points at production. The site-wide copies in
// `apps/web` are the opposite, and always name the canonical production endpoint.
app.get(
  SERVER_CARD_PATH,
  (c) =>
    new Response(JSON.stringify(buildServerCard(mcpResourceUrl(c.req.raw))), {
      headers: {
        'Content-Type': SERVER_CARD_MEDIA_TYPE,
        // Deploys have no purge step, so the TTL is the whole invalidation story.
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    }),
);

app.get(OAUTH_METADATA_PATH, (c) => proxyConnect(c, OAUTH_METADATA_PATH));
app.post('/mcp/register', async (c) => {
  const rateLimitError = await enforceIpRateLimit(
    c,
    c.env.MCP_REGISTRATION_LIMITER,
    'registration',
  );
  if (rateLimitError) return rateLimitError;
  return proxyConnect(c, '/mcp/register');
});
app.post('/mcp/token', (c) => proxyToken(c));
app.get('/mcp/authorize', (c) => {
  const source = new URL(c.req.url);
  const target = new URL('/mcp/authorize', normalizeOrigin(c.env.CONNECT_BASE_URL));
  target.search = source.search;
  if (!target.searchParams.has('resource')) {
    target.searchParams.set('resource', mcpResourceUrl(c.req.raw));
  }
  return c.redirect(target.toString(), 302);
});

app.get('/mcp', async (c) => {
  const rateLimitError = await enforceMcpRateLimit(c);
  if (rateLimitError) return rateLimitError;

  const auth = await authenticate(c);
  if ('error' in auth) return auth.error;

  return mcpSseResponse(c);
});

app.post('/mcp', async (c) => {
  const rateLimitError = await enforceMcpRateLimit(c);
  if (rateLimitError) return rateLimitError;

  const auth = await authenticate(c);
  if ('error' in auth) return auth.error;
  const { userId } = auth;

  let message: JsonRpcMessage;
  try {
    const body = await readRequestBodyWithLimit(c.req.raw, MCP_REQUEST_MAX_BYTES);
    message = JSON.parse(new TextDecoder().decode(body)) as JsonRpcMessage;
  } catch (error) {
    if (error instanceof BodySizeLimitError) {
      return c.json(
        createErrorResponse(null, JsonRpcErrorCode.InvalidRequest, 'Request body is too large'),
        413,
      );
    }
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: JsonRpcErrorCode.ParseError, message: 'Parse error: Invalid JSON' },
      },
      400,
    );
  }

  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return c.json(
      createErrorResponse(null, JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC message'),
      400,
    );
  }

  if (isNotification(message)) {
    return traceMcpInteraction(message, c.req.header('Mcp-Session-Id'), undefined, () =>
      c.body(null, 202),
    );
  }

  if (!isRequest(message)) {
    return c.json(
      createErrorResponse(null, JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC message'),
      400,
    );
  }

  const headers = c.req.raw.headers;
  const era = requestEra(message, headers);
  // Modern revisions have no sessions: ignore the header rather than validating it.
  const sessionId = era === 'legacy' ? c.req.header('Mcp-Session-Id') : undefined;
  let status: RpcOutcome['status'] = 200;
  const response = await traceMcpInteraction(message, sessionId, undefined, async () => {
    const outcome = await handleRpcRequest(c.env, message, era, { headers, sessionId, userId });
    status = outcome.status;
    if (outcome.status !== 200) {
      c.get('logger').warn('mcp.rpc_rejected', {
        era,
        method: message.method,
        status: outcome.status,
        code: outcome.response.error?.code,
      });
    }
    return outcome.response;
  });

  const result = response.result as { sessionId?: string } | undefined;
  if (result && typeof result === 'object' && 'sessionId' in result && result.sessionId) {
    c.header('Mcp-Session-Id', result.sessionId);
  }
  return c.json(response, status);
});

// Stateless sessions self-expire via the session token's TTL, so termination is
// a client-side discard. Ack so spec-compliant clients are satisfied.
app.delete('/mcp', async (c) => {
  const rateLimitError = await enforceMcpRateLimit(c);
  if (rateLimitError) return rateLimitError;

  const auth = await authenticate(c);
  if ('error' in auth) return auth.error;
  return c.body(null, 204);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

const instrumentedMcp = Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    ...sentryRequestPrivacy(),
  }),
  app,
);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return instrumentedMcp.fetch(normalizeTraceRequest(request), env, ctx);
  },
};
