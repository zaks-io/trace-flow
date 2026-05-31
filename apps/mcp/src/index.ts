import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { axiomConfigFromEnv, createWorkerLogger, type Logger } from '@trace-flow/logging';
import {
  JsonRpcErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  MCP_SERVER_INFO,
  MCP_SERVER_CAPABILITIES,
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

app.use('*', async (c, next) => {
  const mw = cors({
    origin: '*',
    allowMethods: ['POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
    exposeHeaders: ['Mcp-Session-Id'],
    maxAge: 86400,
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return mw(c, next);
});

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
  if (c.req.method !== 'OPTIONS') {
    logger.info('mcp.request_complete', {
      status: c.res.status,
      latencyMs: Date.now() - start,
    });
  }
  c.executionCtx.waitUntil(logger.flush());
});

function getClientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

/** Bearer access-token auth shared by POST and DELETE. */
async function authenticate(c: {
  req: { header(name: string): string | undefined };
  env: Env;
}): Promise<{ userId: string } | { error: Response }> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: jsonResponse({ error: 'Missing or invalid Authorization header' }, 401),
    };
  }
  const payload = await verifyAccessToken(authHeader.slice(7), c.env.CONNECT_BASE_URL);
  if (!payload) {
    return { error: jsonResponse({ error: 'Invalid or expired access token' }, 401) };
  }
  return { userId: payload.userId };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

app.post('/mcp', async (c) => {
  const logger = c.get('logger');

  const limit = await c.env.MCP_LIMITER.limit({ key: getClientIp(c.req.raw) });
  if (!limit.success) {
    logger.warn('mcp.rate_limited', { keyClass: 'ip' });
    return c.json({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
  }

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

  if (isNotification(message)) {
    // Stateless: notifications/initialized has no server state to advance.
    return c.body(null, 204);
  }

  if (!isRequest(message)) {
    return c.json(
      createErrorResponse(null, JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC message'),
    );
  }

  const response = await handleRequest(c.env, message, c.req.header('Mcp-Session-Id'), userId);
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
    tracesSampleRate: 0.1,
  }),
  app,
);
