import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerBackend, McpBackendError } from '../backend';

const CONFIG = { connectBaseUrl: 'https://connect.test', sharedSecret: 'secret' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badJsonResponse(status = 200): Response {
  return new Response('{', {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createWorkerBackend', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches /context once and shares it across the three context-backed ops', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        enabled: true,
        retentionDays: 90,
        apiKeys: [{ id: 'k1', name: 'prod', expiresAt: Number.MAX_SAFE_INTEGER }],
      }),
    );

    const backend = createWorkerBackend('u-1', CONFIG);
    const [keys, resolved, ctx] = await Promise.all([
      backend.listApiKeys(),
      backend.resolveKeyIds(['k1']),
      backend.getUserContext(),
    ]);

    expect(keys).toEqual([{ id: 'k1', name: 'prod', expiresAt: Number.MAX_SAFE_INTEGER }]);
    expect(resolved).toEqual({ ok: true, keyIds: ['k1'] });
    expect(ctx).toEqual({ enabled: true, retentionDays: 90 });
    // Single /context call despite three consumers.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/mcp-backend/context');
  });

  it('flags unowned key ids without a network round trip beyond context', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        enabled: true,
        retentionDays: 30,
        apiKeys: [{ id: 'k1', name: null, expiresAt: Number.MAX_SAFE_INTEGER }],
      }),
    );
    const backend = createWorkerBackend('u-1', CONFIG);
    expect(await backend.resolveKeyIds(['k1', 'nope'])).toEqual({
      ok: false,
      invalidIds: ['nope'],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('mints via /mcp-backend/mint and never sends raw keys', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ token: 'tb-jwt' }));

    const backend = createWorkerBackend('u-1', CONFIG);
    const token = await backend.mintToken(
      [{ type: 'PIPES:READ', resource: 'mcp_traces_list' }],
      ['k1'],
      90,
    );
    expect(token).toBe('tb-jwt');
    const sentBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(sentBody).toMatchObject({ userId: 'u-1', apiKeyIds: ['k1'] });
    // worker is untrusted: it does not get to dictate retentionDays
    expect(sentBody).not.toHaveProperty('retentionDays');
  });

  it('maps a backend 5xx to McpBackendError (-> InternalError upstream)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const backend = createWorkerBackend('u-1', CONFIG);
    await expect(
      backend.mintToken([{ type: 'PIPES:READ', resource: 'x' }], ['k1'], 90),
    ).rejects.toBeInstanceOf(McpBackendError);
  });

  it('rejects malformed context responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ enabled: 'yes' }));
    const backend = createWorkerBackend('u-1', CONFIG);
    await expect(backend.getUserContext()).rejects.toMatchObject({
      name: 'McpBackendError',
      status: 502,
    });
  });

  it('rejects invalid JSON context responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(badJsonResponse());
    const backend = createWorkerBackend('u-1', CONFIG);
    await expect(backend.getUserContext()).rejects.toMatchObject({
      name: 'McpBackendError',
      message: 'context response malformed',
      status: 502,
    });
  });

  it('rejects malformed mint responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ token: 123 }));
    const backend = createWorkerBackend('u-1', CONFIG);
    await expect(
      backend.mintToken([{ type: 'PIPES:READ', resource: 'x' }], ['k1'], 90),
    ).rejects.toMatchObject({
      name: 'McpBackendError',
      status: 502,
    });
  });

  it('rejects invalid JSON mint responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(badJsonResponse());
    const backend = createWorkerBackend('u-1', CONFIG);
    await expect(
      backend.mintToken([{ type: 'PIPES:READ', resource: 'x' }], ['k1'], 90),
    ).rejects.toMatchObject({
      name: 'McpBackendError',
      message: 'mint response malformed',
      status: 502,
    });
  });

  it('wraps network failures as McpBackendError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const backend = createWorkerBackend('u-1', CONFIG);
    await expect(backend.getUserContext()).rejects.toMatchObject({
      name: 'McpBackendError',
      status: 502,
    });
  });

  it('returns null context for a 404 user', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'nope' }, 404));
    const backend = createWorkerBackend('u-1', CONFIG);
    expect(await backend.getUserContext()).toBeNull();
  });
});
