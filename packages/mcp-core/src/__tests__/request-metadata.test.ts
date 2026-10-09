import { describe, expect, it } from 'vitest';
import { decodeMcpHeaderValue, findHeaderMismatch, readRequestMeta } from '../request-metadata';
import { handleServerDiscover, toModernResponse, RESULT_CACHE_HINTS } from '../result-metadata';
import { createErrorResponse, createSuccessResponse } from '../handler';
import type { JsonRpcRequest } from '../protocol';

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'client', version: '1.0.0' },
};

function toolCall(name: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, _meta: META } };
}

function headers(values: Record<string, string>): Headers {
  return new Headers({
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/call',
    ...values,
  });
}

describe('readRequestMeta', () => {
  it('reads version and client identity from _meta', () => {
    expect(readRequestMeta({ _meta: META })).toEqual({
      protocolVersion: '2026-07-28',
      clientInfo: { name: 'client', version: '1.0.0' },
    });
  });

  it('ignores malformed metadata', () => {
    expect(readRequestMeta(undefined)).toEqual({});
    expect(
      readRequestMeta({
        _meta: {
          'io.modelcontextprotocol/protocolVersion': 20260728,
          'io.modelcontextprotocol/clientInfo': { name: 'client' },
        },
      }),
    ).toEqual({ protocolVersion: undefined, clientInfo: undefined });
  });
});

describe('decodeMcpHeaderValue', () => {
  it('passes plain values through', () => {
    expect(decodeMcpHeaderValue('get_trace')).toBe('get_trace');
  });

  it('decodes the UTF-8 base64 sentinel', () => {
    expect(decodeMcpHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
  });

  it('rejects malformed base64', () => {
    expect(decodeMcpHeaderValue('=?base64?not base64!?=')).toBeNull();
  });
});

describe('findHeaderMismatch', () => {
  it('accepts headers that mirror the body', () => {
    expect(findHeaderMismatch(toolCall('get_trace'), headers({ 'Mcp-Name': 'get_trace' }))).toBe(
      null,
    );
  });

  it('requires the protocol version header to match _meta', () => {
    const request = toolCall('get_trace');
    const missing = new Headers({ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_trace' });
    expect(findHeaderMismatch(request, missing)).toMatch(/Missing MCP-Protocol-Version/);
    expect(
      findHeaderMismatch(
        request,
        headers({ 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Name': 'get_trace' }),
      ),
    ).toMatch(/does not match _meta/);
  });

  it('does not require Mcp-Name for methods without a name source', () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: META },
    };
    expect(findHeaderMismatch(request, headers({ 'Mcp-Method': 'tools/list' }))).toBeNull();
  });

  it('rejects a name that is not a string in the body', () => {
    expect(findHeaderMismatch(toolCall(42), headers({ 'Mcp-Name': '42' }))).toMatch(
      /does not match params.name/,
    );
  });
});

describe('modern results', () => {
  it('stamps results with resultType, server identity and cache hints', () => {
    const response = toModernResponse(
      createSuccessResponse(1, { tools: [], _meta: { trace: 'kept' } }),
      RESULT_CACHE_HINTS,
    );
    expect(response.result).toEqual({
      tools: [],
      resultType: 'complete',
      ttlMs: RESULT_CACHE_HINTS.ttlMs,
      cacheScope: 'private',
      _meta: {
        trace: 'kept',
        'io.modelcontextprotocol/serverInfo': { name: 'trace-flow-mcp', version: '1.0.0' },
      },
    });
  });

  it('leaves error responses untouched', () => {
    const error = createErrorResponse(1, -32602, 'Unknown tool: x');
    expect(toModernResponse(error)).toBe(error);
  });

  it('advertises every supported version from server/discover, newest first', () => {
    const result = handleServerDiscover('d').result as { supportedVersions: string[] };
    expect(result.supportedVersions[0]).toBe('2026-07-28');
    expect(result.supportedVersions).toContain('2024-11-05');
  });
});
