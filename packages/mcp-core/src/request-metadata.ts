/**
 * Per-request metadata for the stateless MCP revisions (2026-07-28 and later).
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata
 */
import type { JsonRpcRequest } from './protocol';

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';
export const METHOD_HEADER = 'Mcp-Method';
export const NAME_HEADER = 'Mcp-Name';

export interface RequestMeta {
  protocolVersion?: string;
  clientInfo?: { name: string; version: string };
}

/** Methods whose `Mcp-Name` header mirrors a body field. */
const NAME_SOURCES: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestMetaRecord(params: unknown): Record<string, unknown> | undefined {
  if (!isRecord(params)) return undefined;
  return isRecord(params._meta) ? params._meta : undefined;
}

export function readRequestMeta(params: unknown): RequestMeta {
  const meta = requestMetaRecord(params);
  if (!meta) return {};

  const version = meta[META_PROTOCOL_VERSION];
  const clientInfo = meta[META_CLIENT_INFO];
  return {
    protocolVersion: typeof version === 'string' ? version : undefined,
    clientInfo:
      isRecord(clientInfo) &&
      typeof clientInfo.name === 'string' &&
      typeof clientInfo.version === 'string'
        ? { name: clientInfo.name, version: clientInfo.version }
        : undefined,
  };
}

/** Decodes the `=?base64?…?=` sentinel; returns null when the encoding is malformed. */
export function decodeMcpHeaderValue(value: string): string | null {
  const match = BASE64_SENTINEL.exec(value);
  if (!match) return value;
  try {
    const bytes = Uint8Array.from(atob(match[1] ?? ''), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Checks the mirrored request headers against the body, so an intermediary that
 * routes or rate-limits on headers can never disagree with what we execute.
 * Returns a client-safe reason on mismatch, or null when the headers agree.
 */
export function findHeaderMismatch(request: JsonRpcRequest, headers: Headers): string | null {
  const headerVersion = headers.get(PROTOCOL_VERSION_HEADER);
  if (headerVersion === null) return `Missing ${PROTOCOL_VERSION_HEADER} header`;
  const bodyVersion = readRequestMeta(request.params).protocolVersion;
  if (headerVersion !== bodyVersion) {
    return `${PROTOCOL_VERSION_HEADER} header does not match _meta ${META_PROTOCOL_VERSION}`;
  }

  const method = headers.get(METHOD_HEADER);
  if (method === null) return `Missing ${METHOD_HEADER} header`;
  if (method !== request.method) return `${METHOD_HEADER} header does not match request method`;

  const nameSource = NAME_SOURCES[request.method];
  if (!nameSource) return null;
  const encodedName = headers.get(NAME_HEADER);
  if (encodedName === null) return `Missing ${NAME_HEADER} header`;
  const name = decodeMcpHeaderValue(encodedName);
  const bodyName = isRecord(request.params) ? request.params[nameSource] : undefined;
  if (name === null || name !== bodyName) {
    return `${NAME_HEADER} header does not match params.${nameSource}`;
  }
  return null;
}
