import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';

const KEY = '12345678-1234-4123-8123-123456789abc';
const MODERN = '2026-07-28';
const CLIENT = { name: 'modern-client', version: '2.0.0' };

interface RpcBody {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: { supported?: string[] } };
}

function meta(version = MODERN) {
  return {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': CLIENT,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

function rpc(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return SELF.fetch('http://localhost/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'cf-connecting-ip': '203.0.113.90',
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': method,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: meta() } }),
  });
}

describe('MCP 2026-07-28 stateless requests', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url.endsWith('/authorize-api-key')) {
        return Response.json({ authorized: true, userId: 'u-1' });
      }
      return Response.json({
        enabled: true,
        retentionDays: 30,
        apiKeys: [{ id: 'k1', name: 'App', expiresAt: Date.now() + 60_000 }],
      });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('answers server/discover without a session', async () => {
    const res = await rpc('server/discover');

    expect(res.status).toBe(200);
    expect(res.headers.get('Mcp-Session-Id')).toBeNull();
    const body: RpcBody = await res.json();
    expect(body.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: expect.arrayContaining([MODERN, '2025-11-25']),
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'trace-flow-mcp' } },
      ttlMs: expect.any(Number),
      cacheScope: 'private',
    });
  });

  it('lists tools with cache hints and no session', async () => {
    const res = await rpc('tools/list');

    expect(res.status).toBe(200);
    const body: RpcBody = await res.json();
    expect(body.result).toMatchObject({
      resultType: 'complete',
      tools: expect.any(Array),
      ttlMs: expect.any(Number),
      cacheScope: 'private',
    });
  });

  it('calls a tool and ignores a stale session header', async () => {
    const res = await rpc(
      'tools/call',
      { name: 'list_api_keys', arguments: {} },
      { 'Mcp-Name': 'list_api_keys', 'Mcp-Session-Id': 'expired-legacy-session' },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Mcp-Session-Id')).toBeNull();
    const body: { result: { resultType: string; content: { text: string }[] } } = await res.json();
    expect(body.result.resultType).toBe('complete');
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({ total: 1 });
  });

  it('accepts a base64-encoded Mcp-Name', async () => {
    const res = await rpc(
      'tools/call',
      { name: 'list_api_keys', arguments: {} },
      { 'Mcp-Name': `=?base64?${btoa('list_api_keys')}?=` },
    );

    expect(res.status).toBe(200);
  });

  it.each([
    ['a different Mcp-Method', 'tools/list', {}, { 'Mcp-Method': 'tools/call' }],
    ['a missing Mcp-Name', 'tools/call', { name: 'list_api_keys' }, {}],
    ['a different Mcp-Name', 'tools/call', { name: 'list_api_keys' }, { 'Mcp-Name': 'get_trace' }],
    [
      'a different MCP-Protocol-Version',
      'tools/list',
      {},
      { 'MCP-Protocol-Version': '2027-01-01' },
    ],
  ])('rejects %s with HeaderMismatch', async (_case, method, params, headers) => {
    const res = await rpc(method, params, headers);

    expect(res.status).toBe(400);
    const body: RpcBody = await res.json();
    expect(body.error?.code).toBe(-32020);
  });

  it('rejects an unsupported version with the versions it supports', async () => {
    const res = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'cf-connecting-ip': '203.0.113.90',
        'MCP-Protocol-Version': '2099-01-01',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list',
        params: { _meta: meta('2099-01-01') },
      }),
    });

    expect(res.status).toBe(400);
    const body: RpcBody = await res.json();
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data?.supported).toContain(MODERN);
  });

  it.each(['ping', 'toString'])(
    '404s %s, which the stateless revision does not define',
    async (method) => {
      const res = await rpc(method);

      expect(res.status).toBe(404);
      const body: RpcBody = await res.json();
      expect(body.error?.code).toBe(-32601);
    },
  );

  it('refuses to open a legacy session at a stateless version', async () => {
    const res = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'cf-connecting-ip': '203.0.113.90',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MODERN, capabilities: {}, clientInfo: CLIENT },
      }),
    });

    expect(res.headers.get('Mcp-Session-Id')).toBeNull();
    const body: RpcBody = await res.json();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.data?.supported).not.toContain(MODERN);
  });
});

describe('MCP legacy notifications', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts a notification with 202', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ authorized: true, userId: 'u-1' }),
    );
    const res = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'cf-connecting-ip': '203.0.113.91',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    expect(res.status).toBe(202);
  });
});
