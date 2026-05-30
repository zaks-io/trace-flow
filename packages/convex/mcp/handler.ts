import { action, internalAction, type ActionCtx } from '../_generated/server';
import { v } from 'convex/values';
import { internal, api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
  JsonRpcErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  MCP_SERVER_INFO,
  MCP_SERVER_CAPABILITIES,
  isRequest,
  isNotification,
  createErrorResponse,
  createSuccessResponse,
  handleToolsList,
  dispatchToolCall,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcMessage,
  type InitializeParams,
  type InitializeResult,
  type ToolCallParams,
} from '@trace-flow/mcp-core';
import { requireAuthenticated } from '../auth/auth';
import { createMcpBackend } from './backend';

const tinybirdBaseUrl = process.env.TINYBIRD_API_URL ?? 'https://api.us-west-2.aws.tinybird.co';

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
    await requireAuthenticated(ctx);
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
  ctx: ActionCtx,
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
  ctx: ActionCtx,
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
    return dispatchToolCall(
      createMcpBackend(ctx, session.userId),
      tinybirdBaseUrl,
      id,
      params as ToolCallParams,
      session.userId,
    );
  }

  return createErrorResponse(id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
}

async function handleInitialize(
  ctx: ActionCtx,
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

export const terminateSession = action({
  args: {
    sessionId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    await requireAuthenticated(ctx);

    await ctx.runMutation(internal.mcp.session.updateSessionState, {
      sessionId: args.sessionId,
      state: 'shutdown',
    });

    await ctx.runMutation(internal.mcp.session.deleteSession, {
      sessionId: args.sessionId,
    });
  },
});
