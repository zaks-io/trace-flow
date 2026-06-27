/**
 * MCP Protocol Types (Streamable HTTP Transport)
 * JSON-RPC 2.0 and MCP protocol type definitions
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface InitializeParams {
  protocolVersion: string;
  capabilities: {
    roots?: { listChanged?: boolean };
    sampling?: object;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

export function isInitializeParams(params: unknown): params is InitializeParams {
  if (!params || typeof params !== 'object') return false;

  const candidate = params as Record<string, unknown>;
  const clientInfo = candidate.clientInfo as Record<string, unknown> | undefined;

  return (
    typeof candidate.protocolVersion === 'string' &&
    !!candidate.capabilities &&
    typeof candidate.capabilities === 'object' &&
    !Array.isArray(candidate.capabilities) &&
    !!clientInfo &&
    typeof clientInfo === 'object' &&
    !Array.isArray(clientInfo) &&
    typeof clientInfo.name === 'string' &&
    typeof clientInfo.version === 'string'
  );
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    logging?: object;
    prompts?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    tools?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCallResult {
  content: {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }[];
  isError?: boolean;
}

export interface ListToolsParams {
  cursor?: string;
}

export interface ListToolsResult {
  tools: ToolDefinition[];
  nextCursor?: string;
}

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SESSION_TTL_MS = 86400000; // 24 hours in milliseconds

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export const MCP_SERVER_INFO = {
  name: 'trace-flow-mcp',
  version: '1.0.0',
} as const;

export const MCP_SERVER_CAPABILITIES = {
  tools: { listChanged: false },
} as const;
