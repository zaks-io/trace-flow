import * as Sentry from '@sentry/cloudflare';
import {
  JsonRpcErrorCode,
  LEGACY_PROTOCOL_VERSIONS,
  MCP_SERVER_CAPABILITIES,
  MCP_SERVER_INFO,
  PROTOCOL_VERSION_HEADER,
  RESULT_CACHE_HINTS,
  SUPPORTED_PROTOCOL_VERSIONS,
  createErrorResponse,
  createSuccessResponse,
  dispatchToolCall,
  findHeaderMismatch,
  handleServerDiscover,
  handleToolsList,
  isInitializeParams,
  isLegacyProtocolVersion,
  isModernProtocolVersion,
  readRequestMeta,
  toModernResponse,
  type InitializeResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolCallParams,
} from '@trace-flow/mcp-core';
import { mintSessionToken, verifySessionToken } from './sessions';
import { createWorkerBackend } from './backend';

export interface RpcEnv {
  CONNECT_BASE_URL: string;
  TINYBIRD_API_URL: string;
  MCP_BACKEND_SHARED_SECRET: string;
  MCP_SESSION_SECRET: string;
}

export interface RpcOutcome {
  response: JsonRpcResponse;
  status: 200 | 400 | 404;
}

/** Legacy revisions open a session with `initialize`; modern ones are stateless. */
export type ProtocolEra = 'legacy' | 'modern';

function ok(response: JsonRpcResponse): RpcOutcome {
  return { response, status: 200 };
}

/**
 * A dual-era server selects semantics from how the client opens: `initialize`
 * starts a legacy session, while per-request `_meta`, `server/discover`, or a
 * version header naming no legacy revision selects the stateless protocol.
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions
 */
export function requestEra(request: JsonRpcRequest, headers: Headers): ProtocolEra {
  if (request.method === 'initialize') return 'legacy';
  if (request.method === 'server/discover') return 'modern';
  if (readRequestMeta(request.params).protocolVersion !== undefined) return 'modern';
  const headerVersion = headers.get(PROTOCOL_VERSION_HEADER);
  return headerVersion !== null && !isLegacyProtocolVersion(headerVersion) ? 'modern' : 'legacy';
}

export function handleRpcRequest(
  env: RpcEnv,
  request: JsonRpcRequest,
  era: ProtocolEra,
  context: { headers: Headers; sessionId: string | undefined; userId: string },
): Promise<RpcOutcome> {
  return era === 'modern'
    ? handleModernRequest(env, request, context.headers, context.userId)
    : handleLegacyRequest(env, request, context.sessionId, context.userId);
}

function callTool(
  env: RpcEnv,
  userId: string,
  request: JsonRpcRequest,
  protocolVersion: string,
): Promise<JsonRpcResponse> {
  const backend = createWorkerBackend(userId, {
    connectBaseUrl: env.CONNECT_BASE_URL,
    sharedSecret: env.MCP_BACKEND_SHARED_SECRET,
  });
  return dispatchToolCall(
    backend,
    env.TINYBIRD_API_URL,
    request.id,
    request.params as ToolCallParams,
    protocolVersion,
  );
}

async function handleModernRequest(
  env: RpcEnv,
  request: JsonRpcRequest,
  headers: Headers,
  userId: string,
): Promise<RpcOutcome> {
  const { id, method } = request;

  const mismatch = findHeaderMismatch(request, headers);
  if (mismatch) {
    return {
      response: createErrorResponse(id, JsonRpcErrorCode.HeaderMismatch, mismatch),
      status: 400,
    };
  }

  const version = readRequestMeta(request.params).protocolVersion;
  if (version === undefined || !isModernProtocolVersion(version)) {
    return {
      response: createErrorResponse(
        id,
        JsonRpcErrorCode.UnsupportedProtocolVersion,
        'Unsupported protocol version',
        { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: version ?? null },
      ),
      status: 400,
    };
  }

  switch (method) {
    case 'server/discover':
      return ok(handleServerDiscover(id));
    case 'tools/list':
      return ok(toModernResponse(handleToolsList(id), RESULT_CACHE_HINTS));
    case 'tools/call':
      return ok(toModernResponse(await callTool(env, userId, request, version)));
    default:
      // A JSON-RPC body on the 404 tells dual-era clients this is a modern server
      // without the method, not a legacy server missing the endpoint.
      return {
        response: createErrorResponse(
          id,
          JsonRpcErrorCode.MethodNotFound,
          `Method not found: ${method}`,
        ),
        status: 404,
      };
  }
}

async function handleLegacyRequest(
  env: RpcEnv,
  request: JsonRpcRequest,
  sessionId: string | undefined,
  userId: string,
): Promise<RpcOutcome> {
  const { method, params, id } = request;

  if (method === 'initialize') {
    if (!isInitializeParams(params)) {
      return ok(
        createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Invalid initialize params'),
      );
    }
    return ok(await handleInitialize(env, id, params.protocolVersion, userId));
  }

  if (method === 'ping') {
    return ok(createSuccessResponse(id, {}));
  }

  if (!sessionId) {
    return {
      response: createErrorResponse(
        id,
        JsonRpcErrorCode.InvalidRequest,
        'Session not initialized. Please send initialize request first.',
      ),
      status: 400,
    };
  }

  // The spec requires 404 for a terminated session; clients re-initialize only on that
  // status, so any other code leaves a long-running client stuck once the session expires.
  const session = await verifySessionToken(sessionId, env.MCP_SESSION_SECRET);
  if (session?.userId !== userId) {
    return {
      response: createErrorResponse(
        id,
        JsonRpcErrorCode.InvalidRequest,
        'Session not found or expired.',
      ),
      status: 404,
    };
  }
  Sentry.getActiveSpan()?.setAttribute('mcp.protocol.version', session.protocolVersion);

  if (method === 'tools/list') {
    return ok(handleToolsList(id));
  }

  if (method === 'tools/call') {
    return ok(await callTool(env, userId, request, session.protocolVersion));
  }

  return ok(
    createErrorResponse(id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`),
  );
}

async function handleInitialize(
  env: RpcEnv,
  id: string | number,
  requestedVersion: string,
  userId: string,
): Promise<JsonRpcResponse> {
  // Modern revisions have no handshake, so only legacy versions can open a session.
  if (!isLegacyProtocolVersion(requestedVersion)) {
    return createErrorResponse(
      id,
      JsonRpcErrorCode.InvalidParams,
      `Unsupported protocol version: ${requestedVersion}`,
      { supported: LEGACY_PROTOCOL_VERSIONS, requested: requestedVersion },
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
