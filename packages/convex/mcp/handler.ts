import { action, internalAction } from '../_generated/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  InitializeParams,
  InitializeResult,
  ListToolsResult,
  ToolCallParams,
  ToolCallResult,
} from './protocol';
import {
  JsonRpcErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  MCP_SERVER_INFO,
  MCP_SERVER_CAPABILITIES,
} from './protocol';
import { TOOL_DEFINITIONS } from './tools';
import { requireTraceFlowRole } from '../auth/auth';
import { api } from '../_generated/api';
import { listTraces } from './tools/listTracesAction';
import { getTrace } from './tools/getTraceAction';
import { getTraceSpans } from './tools/getTraceSpansAction';
import { getTraceEvents } from './tools/getTraceEventsAction';
import { listTraceSummaries } from './tools/listTraceSummaries';
import { getUsageSummary, listModelUsage, listOperationUsage } from './tools/analytics';

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'id' in message && message.id !== undefined;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !('id' in message) || message.id === undefined;
}

export function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

export function createSuccessResponse(id: string | number, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

const jsonRpcResponseValidator = v.object({
  jsonrpc: v.literal('2.0'),
  id: v.union(v.string(), v.number(), v.null()),
  result: v.optional(v.any()),
  error: v.optional(
    v.object({
      code: v.number(),
      message: v.string(),
      data: v.optional(v.any()),
    }),
  ),
});

export const handleMessage = action({
  args: {
    message: v.any(),
    sessionId: v.optional(v.string()),
  },
  returns: v.union(jsonRpcResponseValidator, v.null()),
  handler: async (ctx, args): Promise<JsonRpcResponse | null> => {
    await requireTraceFlowRole(ctx);
    const user = await ctx.runQuery(api.auth.users.getCurrentUserQuery);
    if (!user?.enabled) {
      return createErrorResponse(
        null,
        JsonRpcErrorCode.InternalError,
        'User not found or not enabled',
      );
    }

    const message = args.message as JsonRpcMessage;

    if (isNotification(message)) {
      await handleNotification(ctx, message, args.sessionId);
      return null;
    }

    if (isRequest(message)) {
      return handleRequest(ctx, message, args.sessionId, user._id);
    }

    return createErrorResponse(null, JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC message');
  },
});

export const handleMessageWithUser = internalAction({
  args: {
    message: v.any(),
    sessionId: v.optional(v.string()),
    userId: v.id('users'),
  },
  returns: v.union(jsonRpcResponseValidator, v.null()),
  handler: async (ctx, args): Promise<JsonRpcResponse | null> => {
    const message = args.message as JsonRpcMessage;

    if (isNotification(message)) {
      await handleNotification(ctx, message, args.sessionId);
      return null;
    }

    if (isRequest(message)) {
      return handleRequest(ctx, message, args.sessionId, args.userId);
    }

    return createErrorResponse(null, JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC message');
  },
});

async function handleNotification(
  ctx: { runMutation: typeof action.prototype.runMutation },
  notification: JsonRpcNotification,
  sessionId: string | undefined,
): Promise<void> {
  if (notification.method === 'notifications/initialized' && sessionId) {
    await ctx.runMutation(internal.mcp.session.updateSessionState, {
      sessionId,
      state: 'ready',
    });
  }
}

async function handleRequest(
  ctx: {
    runQuery: typeof action.prototype.runQuery;
    runMutation: typeof action.prototype.runMutation;
    runAction: typeof action.prototype.runAction;
  },
  request: JsonRpcRequest,
  sessionId: string | undefined,
  userId: Id<'users'>,
): Promise<JsonRpcResponse> {
  const { method, params, id } = request;

  if (method === 'initialize') {
    return handleInitialize(ctx, id, params as InitializeParams, userId);
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

  const session = await ctx.runQuery(internal.mcp.session.getSessionInternal, { sessionId });

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

  if (session.state === 'initializing') {
    return createErrorResponse(
      id,
      JsonRpcErrorCode.InvalidRequest,
      'Session not ready. Please send notifications/initialized notification after initialize response.',
    );
  }

  if (session.state === 'shutdown') {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidRequest, 'Session has been shut down.');
  }

  if (method === 'tools/list') {
    return handleToolsList(id);
  }

  if (method === 'tools/call') {
    return handleToolsCall(ctx, id, params as ToolCallParams, session.userId);
  }

  return createErrorResponse(id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
}

async function handleInitialize(
  ctx: { runMutation: typeof action.prototype.runMutation },
  id: string | number,
  params: InitializeParams,
  userId: Id<'users'>,
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
      {
        supported: SUPPORTED_PROTOCOL_VERSIONS,
        requested: requestedVersion,
      },
    );
  }

  const sessionId = await ctx.runMutation(internal.mcp.session.createSession, {
    userId,
    protocolVersion: requestedVersion,
  });

  const result: InitializeResult & { sessionId: string } = {
    protocolVersion: requestedVersion,
    capabilities: MCP_SERVER_CAPABILITIES,
    serverInfo: MCP_SERVER_INFO,
    sessionId,
  };

  return createSuccessResponse(id, result);
}

function handleToolsList(id: string | number): JsonRpcResponse {
  const result: ListToolsResult = {
    tools: TOOL_DEFINITIONS,
  };

  return createSuccessResponse(id, result);
}

export function resolveApiKeys(
  allApiKeys: { _id: string; key: string }[],
  requestedIds?: string[],
): string[] | { error: string } {
  if (!requestedIds || requestedIds.length === 0) {
    return allApiKeys.map((k) => k.key);
  }

  const keyMap = new Map(allApiKeys.map((k) => [k._id, k.key]));
  const resolved: string[] = [];
  const invalid: string[] = [];

  for (const id of requestedIds) {
    const raw = keyMap.get(id);
    if (raw) {
      resolved.push(raw);
    } else {
      invalid.push(id);
    }
  }

  if (invalid.length > 0) {
    return { error: `Invalid or unauthorized API key IDs: ${invalid.join(', ')}` };
  }

  return resolved;
}

async function handleToolsCall(
  ctx: {
    runQuery: typeof action.prototype.runQuery;
    runAction: typeof action.prototype.runAction;
  },
  id: string | number,
  params: ToolCallParams,
  userId: Id<'users'>,
): Promise<JsonRpcResponse> {
  if (!params.name) {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Missing tool name');
  }

  if (params.name === 'list_api_keys') {
    const result = await ctx.runAction(internal.mcp.tools.listApiKeysAction.listApiKeys, {
      userId,
    });
    return createSuccessResponse(id, result);
  }

  const now = Date.now();
  const allApiKeys = await ctx.runQuery(internal.apiKeys.listForUser, { userId });
  const apiKeys = allApiKeys.filter((k: { expiresAt: number }) => k.expiresAt > now);

  const rawIds = params.arguments?.api_key_ids;
  if (
    rawIds !== undefined &&
    (!Array.isArray(rawIds) || !rawIds.every((v) => typeof v === 'string'))
  ) {
    return createErrorResponse(
      id,
      JsonRpcErrorCode.InvalidParams,
      'api_key_ids must be an array of strings',
    );
  }
  const requestedIds = rawIds;

  const resolved = resolveApiKeys(apiKeys, requestedIds);

  if (typeof resolved === 'object' && 'error' in resolved) {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, resolved.error);
  }

  const apiKeyStrings = resolved;

  let result: ToolCallResult;

  if (params.name === 'list_traces') {
    const listArgs = (params.arguments ?? {}) as {
      provider?: string;
      model?: string;
      status?: string;
      limit?: number;
      hours?: number;
      cursor?: string;
      sort_by?: string;
      order?: string;
    };
    result = await listTraces(apiKeyStrings, listArgs);
  } else if (params.name === 'list_trace_summaries') {
    const listArgs = (params.arguments ?? {}) as {
      provider?: string;
      model?: string;
      status?: string;
      operation?: string;
      search?: string;
      limit?: number;
      hours?: number;
      cursor?: string;
      sort_by?: string;
      order?: string;
    };
    result = await listTraceSummaries(apiKeyStrings, listArgs);
  } else if (params.name === 'get_trace') {
    const getArgs = (params.arguments ?? {}) as {
      trace_id: string;
    };
    result = await getTrace(apiKeyStrings, getArgs);
  } else if (params.name === 'get_trace_spans') {
    const getSpansArgs = (params.arguments ?? {}) as {
      trace_id: string;
      expand?: string[];
      span_names?: string[];
      exclude_span_names?: string[];
      min_duration_ms?: number;
      sort_by?: string;
      order?: string;
      top_n?: number;
      limit?: number;
      cursor?: string;
    };
    result = await getTraceSpans(apiKeyStrings, getSpansArgs);
  } else if (params.name === 'get_trace_events') {
    const getEventsArgs = (params.arguments ?? {}) as {
      trace_id: string;
      span_id?: string;
      span_names?: string[];
      event_names?: string[];
      order?: string;
      limit?: number;
      cursor?: string;
    };
    result = await getTraceEvents(apiKeyStrings, getEventsArgs);
  } else if (params.name === 'get_usage_summary') {
    const usageArgs = (params.arguments ?? {}) as {
      hours?: number;
      provider?: string;
      model?: string;
      operation?: string;
      status?: string;
    };
    result = await getUsageSummary(apiKeyStrings, usageArgs);
  } else if (params.name === 'list_operation_usage') {
    const operationsArgs = (params.arguments ?? {}) as {
      hours?: number;
      provider?: string;
      model?: string;
      operation?: string;
      status?: string;
      limit?: number;
    };
    result = await listOperationUsage(apiKeyStrings, operationsArgs);
  } else if (params.name === 'list_model_usage') {
    const modelsArgs = (params.arguments ?? {}) as {
      hours?: number;
      provider?: string;
      operation?: string;
      status?: string;
    };
    result = await listModelUsage(apiKeyStrings, modelsArgs);
  } else {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
  }

  return createSuccessResponse(id, result);
}

export const terminateSession = action({
  args: {
    sessionId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    await requireTraceFlowRole(ctx);

    await ctx.runMutation(internal.mcp.session.updateSessionState, {
      sessionId: args.sessionId,
      state: 'shutdown',
    });

    await ctx.runMutation(internal.mcp.session.deleteSession, {
      sessionId: args.sessionId,
    });
  },
});
