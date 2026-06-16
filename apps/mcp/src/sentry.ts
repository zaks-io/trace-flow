import * as Sentry from '@sentry/cloudflare';
import {
  JsonRpcErrorCode,
  MCP_SERVER_INFO,
  isInitializeParams,
  isNotification,
  isRequest,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolCallParams,
} from '@trace-flow/mcp-core';
import type { Span } from '@sentry/cloudflare';

type SpanAttributes = Parameters<Span['setAttributes']>[0];
type McpSpanMessage = JsonRpcRequest | JsonRpcNotification;

const OK_STATUS = { code: 1 as const, message: 'ok' };
const ERROR_STATUS_CODE = 2 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isToolCallParams(params: unknown): params is ToolCallParams {
  return isRecord(params) && typeof params.name === 'string';
}

function toolCallTarget(message: McpSpanMessage): string | undefined {
  return message.method === 'tools/call' && isToolCallParams(message.params)
    ? message.params.name
    : undefined;
}

function requestId(message: McpSpanMessage): string | undefined {
  return isRequest(message) ? String(message.id) : undefined;
}

async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function protocolVersion(
  message: McpSpanMessage,
  sessionProtocolVersion?: string,
): string | undefined {
  if (message.method === 'initialize' && isInitializeParams(message.params)) {
    return message.params.protocolVersion;
  }
  return sessionProtocolVersion;
}

function clientAttributes(message: McpSpanMessage): SpanAttributes {
  if (message.method !== 'initialize' || !isInitializeParams(message.params)) {
    return {};
  }

  const { clientInfo } = message.params;
  return {
    'mcp.client.name': clientInfo.name,
    'mcp.client.version': clientInfo.version,
  };
}

function mcpOperation(message: JsonRpcRequest | JsonRpcNotification): string {
  return isNotification(message) ? 'mcp.notification.client_to_server' : 'mcp.server';
}

function spanStatusMessage(code: number): string {
  switch (code) {
    case JsonRpcErrorCode.MethodNotFound:
      return 'unimplemented';
    case JsonRpcErrorCode.InternalError:
      return 'internal_error';
    default:
      return 'invalid_argument';
  }
}

function toolResultAttributes(response: JsonRpcResponse): SpanAttributes {
  if (!isRecord(response.result)) return {};
  const result = response.result as { content?: unknown; isError?: unknown };
  if (!Array.isArray(result.content)) return {};

  return {
    'mcp.tool.result.is_error': result.isError === true,
    'mcp.tool.result.content_count': result.content.length,
  };
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && value.jsonrpc === '2.0' && 'id' in value;
}

async function resultSessionId(response: JsonRpcResponse): Promise<string | undefined> {
  const result = response.result;
  if (!isRecord(result) || typeof result.sessionId !== 'string') return undefined;
  return hashIdentifier(result.sessionId);
}

export function mcpSpanName(message: JsonRpcRequest | JsonRpcNotification): string {
  const target = toolCallTarget(message);
  return target ? `${message.method} ${target}` : message.method;
}

export async function mcpSpanAttributes(
  message: JsonRpcRequest | JsonRpcNotification,
  sessionId: string | undefined,
  sessionProtocolVersion?: string,
): Promise<SpanAttributes> {
  const op = mcpOperation(message);
  const target = toolCallTarget(message);

  return {
    [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_OP]: op,
    [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: isNotification(message)
      ? 'auto.mcp.notification'
      : 'auto.function.mcp_server',
    [Sentry.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: 'route',
    'mcp.method.name': message.method,
    'mcp.transport': 'StreamableHTTP',
    'network.transport': 'tcp',
    'network.protocol.version': '2.0',
    'mcp.server.name': MCP_SERVER_INFO.name,
    'mcp.server.version': MCP_SERVER_INFO.version,
    'mcp.request.id': requestId(message),
    'mcp.session.id': sessionId ? await hashIdentifier(sessionId) : undefined,
    'mcp.protocol.version': protocolVersion(message, sessionProtocolVersion),
    'mcp.tool.name': target,
    ...clientAttributes(message),
  };
}

async function finishMcpSpan(span: Span, result: unknown): Promise<void> {
  if (result === null) {
    span.setStatus(OK_STATUS);
    return;
  }

  if (!isJsonRpcResponse(result)) {
    return;
  }

  const nextSessionId = await resultSessionId(result);
  if (nextSessionId) span.setAttribute('mcp.session.id', nextSessionId);

  if (result.error) {
    span.setStatus({
      code: ERROR_STATUS_CODE,
      message: spanStatusMessage(result.error.code),
    });
    return;
  }

  span.setStatus(OK_STATUS);
  span.setAttributes(toolResultAttributes(result));
}

export async function traceMcpInteraction<T>(
  message: JsonRpcRequest | JsonRpcNotification,
  sessionId: string | undefined,
  sessionProtocolVersion: string | undefined,
  callback: () => T | Promise<T>,
): Promise<T> {
  const attributes = await mcpSpanAttributes(message, sessionId, sessionProtocolVersion);

  return Sentry.startSpan(
    {
      name: mcpSpanName(message),
      op: mcpOperation(message),
      forceTransaction: true,
      attributes,
    },
    async (span) => {
      try {
        const result = await callback();
        await finishMcpSpan(span, result);
        return result;
      } catch (error) {
        span.setStatus({ code: ERROR_STATUS_CODE, message: 'internal_error' });
        Sentry.captureException(error, {
          tags: {
            operation: 'mcp.interaction',
            mcp_method: message.method,
          },
        });
        throw error;
      }
    },
  );
}
