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
import { requireTraceFlowRole } from '../auth';
import { api } from '../_generated/api';

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

export const handleMessage = action({
  args: {
    message: v.any(),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<JsonRpcResponse | null> => {
    await requireTraceFlowRole(ctx);
    const user = await ctx.runQuery(api.users.getCurrentUserQuery);
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

  const apiKeys = await ctx.runQuery(internal.apiKeys.listByUserId, { userId });
  const apiKeyStrings = apiKeys.map((k: { key: string }) => k.key);

  let result: ToolCallResult;

  if (params.name === 'list_traces') {
    const listArgs = (params.arguments ?? {}) as {
      provider?: string;
      model?: string;
      status?: string;
      limit?: number;
      hours?: number;
      cursor?: string;
    };
    result = await ctx.runAction(internal.mcp.tools.listTracesAction.listTraces, {
      apiKeys: apiKeyStrings,
      params: listArgs,
    });
  } else if (params.name === 'get_trace') {
    const getArgs = (params.arguments ?? {}) as {
      trace_id: string;
    };
    result = await ctx.runAction(internal.mcp.tools.getTraceAction.getTrace, {
      apiKeys: apiKeyStrings,
      params: getArgs,
    });
  } else if (params.name === 'get_trace_spans') {
    const getSpansArgs = (params.arguments ?? {}) as {
      trace_id: string;
      expand?: string[];
      span_names?: string[];
      exclude_span_names?: string[];
      min_duration_ms?: number;
      sort_by?: string;
      top_n?: number;
      limit?: number;
      cursor?: string;
    };
    result = await ctx.runAction(internal.mcp.tools.getTraceSpansAction.getTraceSpans, {
      apiKeys: apiKeyStrings,
      params: getSpansArgs,
    });
  } else if (params.name === 'get_trace_events') {
    const getEventsArgs = (params.arguments ?? {}) as {
      trace_id: string;
      span_id?: string;
      span_names?: string[];
      event_names?: string[];
      limit?: number;
      cursor?: string;
    };
    result = await ctx.runAction(internal.mcp.tools.getTraceEventsAction.getTraceEvents, {
      apiKeys: apiKeyStrings,
      params: getEventsArgs,
    });
  } else {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
  }

  return createSuccessResponse(id, result);
}

export const terminateSession = action({
  args: {
    sessionId: v.string(),
  },
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
