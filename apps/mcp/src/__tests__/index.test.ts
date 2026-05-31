import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';

const CONNECT_ORIGIN = 'https://connect.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MCP worker auth discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('publishes protected resource metadata pointing at Connect', async () => {
    const res = await SELF.fetch('http://localhost/.well-known/oauth-protected-resource');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: 'http://localhost/mcp',
      authorization_servers: [CONNECT_ORIGIN],
      bearer_methods_supported: ['header'],
      resource_name: 'Trace Flow MCP',
    });
  });

  it('401s missing auth with a protected-resource challenge', async () => {
    const res = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': '203.0.113.10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"',
    );
    expect(await res.json()).toEqual({ error: 'Missing or invalid Authorization header' });
  });

  it('proxies authorization-server metadata to Connect for legacy clients', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      expect(req.method).toBe('GET');
      expect(req.url).toBe(`${CONNECT_ORIGIN}/.well-known/oauth-authorization-server`);
      return jsonResponse({ issuer: CONNECT_ORIGIN });
    });

    const res = await SELF.fetch('http://localhost/.well-known/oauth-authorization-server');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: CONNECT_ORIGIN });
  });

  it('proxies dynamic client registration to Connect', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      expect(req.method).toBe('POST');
      expect(req.url).toBe(`${CONNECT_ORIGIN}/mcp/register`);
      expect(await req.json()).toEqual({ client_name: 'Claude Code' });
      return jsonResponse({ client_id: 'client-1' }, 201);
    });

    const res = await SELF.fetch('http://localhost/mcp/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code' }),
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ client_id: 'client-1' });
  });

  it('redirects authorization requests to Connect', async () => {
    const res = await SELF.fetch(
      'http://localhost/mcp/authorize?client_id=client-1&state=state-1',
      { redirect: 'manual' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `${CONNECT_ORIGIN}/mcp/authorize?client_id=client-1&state=state-1&resource=http%3A%2F%2Flocalhost%2Fmcp`,
    );
  });

  it('proxies token exchange to Connect', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      expect(req.method).toBe('POST');
      expect(req.url).toBe(`${CONNECT_ORIGIN}/mcp/token`);
      const body = await req.formData();
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('code-1');
      expect(body.get('resource')).toBe('http://localhost/mcp');
      return jsonResponse({ access_token: 'access-1' });
    });

    const res = await SELF.fetch('http://localhost/mcp/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=code-1',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: 'access-1' });
  });

  it('preserves a client-supplied resource on form token exchange', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      expect(req.method).toBe('POST');
      expect(req.url).toBe(`${CONNECT_ORIGIN}/mcp/token`);
      const body = await req.formData();
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('code-1');
      expect(body.get('resource')).toBe('https://custom.example/mcp');
      return jsonResponse({ access_token: 'access-1' });
    });

    const res = await SELF.fetch('http://localhost/mcp/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=code-1&resource=https%3A%2F%2Fcustom.example%2Fmcp',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: 'access-1' });
  });

  it('preserves a client-supplied resource on raw token exchange', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      expect(req.method).toBe('POST');
      expect(req.url).toBe(`${CONNECT_ORIGIN}/mcp/token`);
      expect(req.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      const body = await req.formData();
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('code-1');
      expect(body.get('resource')).toBe('https://custom.example/mcp');
      return jsonResponse({ access_token: 'access-1' });
    });

    const res = await SELF.fetch('http://localhost/mcp/token', {
      method: 'POST',
      body: new TextEncoder().encode(
        'grant_type=authorization_code&code=code-1&resource=https%3A%2F%2Fcustom.example%2Fmcp',
      ),
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: 'access-1' });
  });
});
