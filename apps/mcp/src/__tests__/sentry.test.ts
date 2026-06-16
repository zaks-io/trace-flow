import { describe, expect, it } from 'vitest';
import { mcpSpanAttributes, mcpSpanName } from '../sentry';

describe('MCP Sentry span metadata', () => {
  it('names tool calls by method and tool name', () => {
    expect(
      mcpSpanName({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_traces', arguments: { api_key_ids: ['key-1'] } },
      }),
    ).toBe('tools/call list_traces');
  });

  it('hashes session ids and omits tool arguments', async () => {
    const attrs = await mcpSpanAttributes(
      {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'tools/call',
        params: { name: 'get_trace', arguments: { trace_id: 'trace-1' } },
      },
      'raw-session-token',
      '2025-11-25',
    );

    expect(attrs['mcp.session.id']).toMatch(/^[a-f0-9]{32}$/);
    expect(attrs['mcp.session.id']).not.toBe('raw-session-token');
    expect(attrs['mcp.tool.name']).toBe('get_trace');
    expect(attrs['mcp.protocol.version']).toBe('2025-11-25');
    expect(Object.keys(attrs).some((key) => key.startsWith('mcp.request.argument'))).toBe(false);
  });

  it('extracts initialize client metadata', async () => {
    const attrs = await mcpSpanAttributes(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'Claude Code', version: '1.2.3' },
        },
      },
      undefined,
    );

    expect(attrs['mcp.method.name']).toBe('initialize');
    expect(attrs['mcp.protocol.version']).toBe('2025-06-18');
    expect(attrs['mcp.client.name']).toBe('Claude Code');
    expect(attrs['mcp.client.version']).toBe('1.2.3');
  });
});
