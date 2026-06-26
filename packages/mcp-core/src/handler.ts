import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  ListToolsResult,
  ToolCallParams,
} from './protocol';
import { JsonRpcErrorCode } from './protocol';
import type { McpBackend } from './backend';
import type { ToolCtx } from './tinybird';
import { listApiKeys } from './tools/listApiKeys';
import {
  getTraceFlowToolDefinitions,
  getTraceFlowToolHandler,
  isTraceFlowToolAvailableOnSurface,
  type TraceFlowToolSurface,
} from './tools/registry';

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

export function handleToolsList(
  id: string | number,
  surface: TraceFlowToolSurface = 'mcp',
): JsonRpcResponse {
  const result: ListToolsResult = {
    tools: getTraceFlowToolDefinitions(surface),
  };

  return createSuccessResponse(id, result);
}

/**
 * Host-agnostic `tools/call` dispatch. The host (Convex action or MCP worker)
 * supplies a user-bound backend + Tinybird base URL. All Tinybird access flows
 * through `backend.mintToken`, so the row-security boundary is enforced
 * identically everywhere.
 */
export async function dispatchToolCall(
  backend: McpBackend,
  tinybirdBaseUrl: string,
  id: string | number,
  params: ToolCallParams,
  protocolVersion?: string,
  surface: TraceFlowToolSurface = 'mcp',
): Promise<JsonRpcResponse> {
  if (!params.name) {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Missing tool name');
  }

  const isListApiKeys = params.name === 'list_api_keys';
  const handler = getTraceFlowToolHandler(params.name);
  if ((!isListApiKeys && !handler) || !isTraceFlowToolAvailableOnSurface(params.name, surface)) {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
  }

  try {
    const userContext = await backend.getUserContext();
    if (!userContext?.enabled) {
      return createErrorResponse(
        id,
        JsonRpcErrorCode.InvalidRequest,
        'User not found or not enabled',
      );
    }

    if (isListApiKeys) {
      const meta = await backend.listApiKeys();
      return createSuccessResponse(id, listApiKeys(meta));
    }
    // The earlier unknown-tool guard covers runtime; this keeps TypeScript narrowed
    // under noUncheckedIndexedAccess after the list_api_keys branch.
    if (!handler) {
      return createErrorResponse(
        id,
        JsonRpcErrorCode.InvalidParams,
        `Unknown tool: ${params.name}`,
      );
    }

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

    const resolved = await backend.resolveKeyIds(requestedIds);
    if (!resolved.ok) {
      return createErrorResponse(
        id,
        JsonRpcErrorCode.InvalidParams,
        `Invalid or unauthorized API key IDs: ${resolved.invalidIds.join(', ')}`,
      );
    }
    const keyIds = resolved.keyIds;

    const { retentionDays } = userContext;

    const ctx: ToolCtx = { mintToken: backend.mintToken, tinybirdBaseUrl, protocolVersion };
    const args = params.arguments ?? {};
    const result = await handler(ctx, keyIds, args, retentionDays);
    return createSuccessResponse(id, result);
  } catch (error) {
    console.error('mcp.dispatch_tool_call_failed', { tool: params.name, error });
    return createErrorResponse(id, JsonRpcErrorCode.InternalError, 'Internal tool error');
  }
}
