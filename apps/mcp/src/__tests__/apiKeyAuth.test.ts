import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { authorizeMcpApiKey } from '../apiKeyAuth';

const KEY = '12345678-1234-4123-8123-123456789abc';
const CONFIG = { connectBaseUrl: 'https://connect.test', sharedSecret: 'test-backend-secret' };

function rpc(method: string, params?: unknown, sessionId?: string, key = KEY) {
  return SELF.fetch('http://localhost/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'cf-connecting-ip': '203.0.113.70',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

const INIT = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'sandbox', version: '1' },
};

describe('MCP API key authentication', () => {
  afterEach(() => vi.restoreAllMocks());

  it('initializes and calls tools with a UUID bearer without OAuth discovery', async () => {
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      paths.push(new URL(req.url).pathname);
      expect(req.headers.get('Authorization')).toBe(`Bearer ${CONFIG.sharedSecret}`);
      if (req.url.endsWith('/authorize-api-key')) {
        expect(await req.json()).toEqual({ key: KEY });
        return Response.json({ authorized: true, userId: 'u-1' });
      }
      expect(req.url).toBe('https://connect.test/mcp-backend/context');
      expect(await req.json()).toEqual({ userId: 'u-1' });
      return Response.json({
        enabled: true,
        retentionDays: 30,
        apiKeys: [{ id: 'k1', name: 'App', expiresAt: Date.now() + 60_000 }],
      });
    });

    const initialized = await rpc('initialize', INIT);
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('Mcp-Session-Id');
    expect(sessionId).toBeTruthy();
    const listed = await rpc('tools/list', undefined, sessionId!);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ result: { tools: expect.any(Array) } });
    const called = await rpc('tools/call', { name: 'list_api_keys', arguments: {} }, sessionId!);
    expect(called.status).toBe(200);
    const body: { result: { content: { text: string }[] } } = await called.json();
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
      total: 1,
      api_keys: [{ id: 'k1', name: 'App' }],
    });
    expect(paths).toEqual([
      '/mcp-backend/authorize-api-key',
      '/mcp-backend/authorize-api-key',
      '/mcp-backend/authorize-api-key',
      '/mcp-backend/context',
    ]);
  });

  it('requires current authorization even after a session has been initialized', async () => {
    let revoked = false;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json(
          revoked ? { authorized: false, reason: 'invalid' } : { authorized: true, userId: 'u-1' },
        ),
      );
    const initialized = await rpc('initialize', INIT);
    revoked = true;
    const res = await rpc('tools/list', undefined, initialized.headers.get('Mcp-Session-Id')!);
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each(['invalid', 'expired'] as const)(
    'rejects %s keys with a bearer challenge',
    async (reason) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Response.json({ authorized: false, reason }),
      );
      const res = await rpc('ping');
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    },
  );

  it('rejects ingest-only keys with the required read permission', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ authorized: false, reason: 'forbidden' }),
    );
    const res = await rpc('initialize', INIT);
    expect(res.status).toBe(403);
    expect(res.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"');
    expect(res.headers.get('WWW-Authenticate')).toContain('scope="mcp:read"');
    expect(await res.json()).toEqual({ error: 'This API key does not have MCP read access' });
  });

  it('fails closed when the backend cannot authorize a key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(null, { status: 500 }),
    );
    expect((await rpc('initialize', INIT)).status).toBe(503);
  });

  it('rejects a session owned by another user', async () => {
    let userId = 'u-1';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ authorized: true, userId }),
    );
    const initialized = await rpc('initialize', INIT);
    userId = 'u-2';
    expect(
      (await rpc('tools/list', undefined, initialized.headers.get('Mcp-Session-Id')!)).status,
    ).toBe(404);
  });

  it('authenticates API keys on the SSE receive and DELETE endpoints', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ authorized: true, userId: 'u-1' }));
    const res = await SELF.fetch('http://localhost/mcp', {
      headers: { Authorization: `Bearer ${KEY}`, 'cf-connecting-ip': '203.0.113.71' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    await res.body!.cancel();
    const deleted = await SELF.fetch('http://localhost/mcp', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${KEY}`, 'cf-connecting-ip': '203.0.113.71' },
    });
    expect(deleted.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rate-limits DELETE before any API key lookup', async () => {
    const ip = '203.0.113.72';
    for (let i = 0; i < 120; i++) await env.MCP_LIMITER.limit({ key: ip });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await SELF.fetch('http://localhost/mcp', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${KEY}`, 'cf-connecting-ip': ip },
    });
    expect(res.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { authorized: true },
    { authorized: true, userId: '' },
    { authorized: false, reason: 'unknown' },
  ])('rejects malformed authorization responses %#', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
    await expect(authorizeMcpApiKey(KEY, CONFIG)).rejects.toThrow('response malformed');
  });
});
