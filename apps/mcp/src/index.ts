import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { axiomConfigFromEnv, createWorkerLogger, type Logger } from '@trace-flow/logging';
import {
  JsonRpcErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  MCP_SERVER_INFO,
  MCP_SERVER_CAPABILITIES,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_PATH,
  buildServerCard,
  buildProtectedResourceMetadata,
  PROTECTED_RESOURCE_METADATA_PATH,
  isRequest,
  isNotification,
  isInitializeParams,
  createErrorResponse,
  createSuccessResponse,
  handleToolsList,
  dispatchToolCall,
  type JsonRpcResponse,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type InitializeParams,
  type InitializeResult,
  type ToolCallParams,
} from '@trace-flow/mcp-core';
import { verifyAccessToken } from './auth';
import { mintSessionToken, verifySessionToken } from './sessions';
import { createWorkerBackend } from './backend';
import { traceMcpInteraction } from './sentry';

interface Env {
  CONNECT_BASE_URL: string;
  TINYBIRD_API_URL: string;
  MCP_BACKEND_SHARED_SECRET: string;
  MCP_SESSION_SECRET: string;
  MCP_LIMITER: RateLimit;
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

const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';
const MCP_SSE_HEARTBEAT_MS = 15_000;

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
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

function protectedResourceUrl(req: Request): string {
  return new URL(PROTECTED_RESOURCE_METADATA_PATH, req.url).toString();
}

function bearerChallenge(req: Request, error?: string): string {
  const params = [`resource_metadata="${protectedResourceUrl(req)}"`];
  if (error) params.push(`error="${error}"`);
  return `Bearer ${params.join(', ')}`;
}

function unauthorizedResponse(req: Request, message: string, error?: string): Response {
  return jsonResponse({ error: message }, 401, {
    'WWW-Authenticate': bearerChallenge(req, error),
  });
}

async function proxyConnect(
  c: { req: { raw: Request }; env: Env },
  path: string,
): Promise<Response> {
  const url = new URL(path, normalizeOrigin(c.env.CONNECT_BASE_URL));
  const req = new Request(url, c.req.raw);
  return fetch(req);
}

async function proxyToken(c: { req: { raw: Request }; env: Env }): Promise<Response> {
  const url = new URL('/mcp/token', normalizeOrigin(c.env.CONNECT_BASE_URL));
  const headers = new Headers(c.req.raw.headers);
  headers.delete('content-length');

  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType || contentType.startsWith('application/x-www-form-urlencoded')) {
    let body: URLSearchParams;
    if (contentType) {
      body = new URLSearchParams();
      for (const [key, value] of await c.req.raw.formData()) {
        if (typeof value === 'string') body.append(key, value);
      }
    } else {
      body = new URLSearchParams(await c.req.raw.text());
    }
    if (!body.has('resource')) body.set('resource', mcpResourceUrl(c.req.raw));
    headers.set('content-type', 'application/x-www-form-urlencoded');
    return fetch(url, { method: 'POST', headers, body: body.toString() });
  }

  return fetch(new Request(url, c.req.raw));
}

/** Bearer access-token auth shared by POST and DELETE. */
async function authenticate(c: {
  req: { raw: Request; header(name: string): string | undefined };
  env: Env;
  get(name: 'logger'): Logger;
}): Promise<{ userId: string } | { error: Response }> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: unauthorizedResponse(c.req.raw, 'Missing or invalid Authorization header'),
    };
  }
  let payload;
  try {
    payload = await verifyAccessToken(
      authHeader.slice(7),
      c.env.CONNECT_BASE_URL,
      mcpResourceUrl(c.req.raw),
      c.get('logger'),
    );
  } catch {
    return { error: jsonResponse({ error: 'Token verification temporarily unavailable' }, 503) };
  }
  if (!payload) {
    return {
      error: unauthorizedResponse(c.req.raw, 'Invalid or expired access token', 'invalid_token'),
    };
  }
  return { userId: payload.userId };
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

async function enforceMcpRateLimit(c: {
  req: { raw: Request };
  env: Env;
  get(key: 'logger'): Logger;
}): Promise<Response | null> {
  const logger = c.get('logger');
  const clientIp = getClientIp(c.req.raw);
  if (!clientIp) {
    logger.warn('mcp.client_ip_missing');
    return jsonResponse({ error: 'Missing client IP' }, 400);
  }

  const limit = await c.env.MCP_LIMITER.limit({ key: clientIp });
  if (!limit.success) {
    logger.warn('mcp.rate_limited', { keyClass: 'ip' });
    return jsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
  }

  return null;
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
app.post('/mcp/register', (c) => proxyConnect(c, '/mcp/register'));
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
    message = await c.req.json<JsonRpcMessage>();
  } catch {
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
      c.body(null, 204),
    );
  }

  if (!isRequest(message)) {
    return c.json(
      createErrorResponse(null, JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC message'),
      400,
    );
  }

  const sessionId = c.req.header('Mcp-Session-Id');
  const response = await traceMcpInteraction(message, sessionId, undefined, () =>
    handleRequest(c.env, message, sessionId, userId),
  );
  if (response === null) return c.body(null, 204);

  const result = response.result as { sessionId?: string } | undefined;
  if (result && typeof result === 'object' && 'sessionId' in result && result.sessionId) {
    c.header('Mcp-Session-Id', result.sessionId);
  }
  return c.json(response);
});

// Stateless sessions self-expire via the session token's TTL, so termination is
// a client-side discard. Ack so spec-compliant clients are satisfied.
app.delete('/mcp', async (c) => {
  const auth = await authenticate(c);
  if ('error' in auth) return auth.error;
  return c.body(null, 204);
});

async function handleRequest(
  env: Env,
  request: JsonRpcRequest,
  sessionId: string | undefined,
  userId: string,
): Promise<JsonRpcResponse | null> {
  const { method, params, id } = request;

  if (method === 'initialize') {
    if (!isInitializeParams(params)) {
      return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Invalid initialize params');
    }
    return handleInitialize(env, id, params, userId);
  }

  if (method === 'ping') {
    return createSuccessResponse(id, {});
  }

  if (!sessionId) {
    return createErrorResponse(
      id,
      JsonRpcErrorCode.InvalidRequest,
      'Session not initialized. Please send initialize request first.',
    );
  }

  const session = await verifySessionToken(sessionId, env.MCP_SESSION_SECRET);
  if (!session) {
    return createErrorResponse(
      id,
      JsonRpcErrorCode.InvalidRequest,
      'Session not found or expired.',
    );
  }
  if (session.userId !== userId) {
    return createErrorResponse(
      id,
      JsonRpcErrorCode.InvalidRequest,
      'Session does not belong to this user.',
    );
  }
  Sentry.getActiveSpan()?.setAttribute('mcp.protocol.version', session.protocolVersion);

  if (method === 'tools/list') {
    return handleToolsList(id);
  }

  if (method === 'tools/call') {
    const backend = createWorkerBackend(userId, {
      connectBaseUrl: env.CONNECT_BASE_URL,
      sharedSecret: env.MCP_BACKEND_SHARED_SECRET,
    });
    return dispatchToolCall(
      backend,
      env.TINYBIRD_API_URL,
      id,
      params as ToolCallParams,
      session.protocolVersion,
    );
  }

  return createErrorResponse(id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
}

async function handleInitialize(
  env: Env,
  id: string | number,
  params: InitializeParams,
  userId: string,
): Promise<JsonRpcResponse> {
  const requestedVersion = params.protocolVersion;
  if (
    !SUPPORTED_PROTOCOL_VERSIONS.includes(
      requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
  ) {
    return createErrorResponse(
      id,
      JsonRpcErrorCode.InvalidParams,
      `Unsupported protocol version: ${requestedVersion}`,
      { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: requestedVersion },
    );
  }

  const sessionId = await mintSessionToken(
    { userId, protocolVersion: requestedVersion },
    env.MCP_SESSION_SECRET,
  );

  const result: InitializeResult & { sessionId: string } = {
    protocolVersion: requestedVersion,
    capabilities: MCP_SERVER_CAPABILITIES,
    serverInfo: MCP_SERVER_INFO,
    sessionId,
  };
  return createSuccessResponse(id, result);
}

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
  }),
  app,
);
