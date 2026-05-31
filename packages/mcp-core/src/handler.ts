import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  ListToolsResult,
  ToolCallParams,
  ToolCallResult,
} from './protocol';
import { JsonRpcErrorCode } from './protocol';
import { TOOL_DEFINITIONS } from './tools/definitions';
import type { McpBackend } from './backend';
import type { ToolCtx } from './tinybird';
import { listTraces } from './tools/listTracesAction';
import { getTrace } from './tools/getTraceAction';
import { getTraceSpans } from './tools/getTraceSpansAction';
import { getTraceEvents } from './tools/getTraceEventsAction';
import { listTraceSummaries } from './tools/listTraceSummaries';
import { getUsageSummary, listModelUsage, listOperationUsage } from './tools/analytics';
import { listApiKeys } from './tools/listApiKeys';

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

export function handleToolsList(id: string | number): JsonRpcResponse {
  const result: ListToolsResult = {
    tools: TOOL_DEFINITIONS,
  };

  return createSuccessResponse(id, result);
}

type ToolHandler = (
  ctx: ToolCtx,
  keys: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  retentionDays: number,
) => Promise<ToolCallResult>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_traces: listTraces,
  list_trace_summaries: listTraceSummaries,
  get_trace: getTrace,
  get_trace_spans: getTraceSpans,
  get_trace_events: getTraceEvents,
  get_usage_summary: getUsageSummary,
  list_operation_usage: listOperationUsage,
  list_model_usage: listModelUsage,
};

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
): Promise<JsonRpcResponse> {
  if (!params.name) {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, 'Missing tool name');
  }

  const isListApiKeys = params.name === 'list_api_keys';
  const handler = TOOL_HANDLERS[params.name];
  if (!isListApiKeys && !handler) {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
  }

  const userContext = await backend.getUserContext();
  if (!userContext?.enabled) {
    return createErrorResponse(id, JsonRpcErrorCode.InternalError, 'User not found or not enabled');
  }

  if (isListApiKeys) {
    const meta = await backend.listApiKeys();
    return createSuccessResponse(id, listApiKeys(meta));
  }
  if (!handler) {
    return createErrorResponse(id, JsonRpcErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
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

  const ctx: ToolCtx = { mintToken: backend.mintToken, tinybirdBaseUrl };
  const args = params.arguments ?? {};
  const result = await handler(ctx, keyIds, args, retentionDays);
  return createSuccessResponse(id, result);
}
