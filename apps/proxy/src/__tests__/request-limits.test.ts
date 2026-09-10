import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const waitForAsyncOps = () => new Promise((resolve) => setTimeout(resolve, 100));

function chunkedOversizedBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6 * 1024 * 1024));
      controller.enqueue(new Uint8Array(6 * 1024 * 1024));
      controller.close();
    },
  });
}

async function setupValidApiKey(key: string, orgId: string): Promise<void> {
  await env.API_KEYS.put(
    key,
    JSON.stringify({ expiresAt: Date.now() + 86_400_000, createdAt: Date.now(), orgId }),
  );
  await env.API_KEYS.put(
    `sub:${orgId}`,
    JSON.stringify({ tier: 'pro', status: 'active', monthlyUnits: 1, addonUnits: 1 }),
  );
}

function authorizeApiKey(orgId: string) {
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === 'https://convex.test') {
      return Response.json({
        authorized: true,
        expiresAt: Date.now() + 60_000,
        createdAt: 1,
        orgId,
      });
    }
    throw new Error('unexpected provider request');
  });
}

describe('public request limits', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected provider request'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an oversized chunked proxy request without forwarding or consuming usage', async () => {
    const key = 'chunked-oversize-key';
    const orgId = 'org-chunked-oversize';
    await setupValidApiKey(key, orgId);
    authorizeApiKey(orgId);

    const oversized = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trace-Flow-Api-Key': key },
      body: chunkedOversizedBody(),
    });

    expect(oversized.status).toBe(413);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === 'https://convex.test') {
        return Response.json({
          authorized: true,
          expiresAt: Date.now() + 60_000,
          createdAt: 1,
          orgId,
        });
      }
      await request.arrayBuffer();
      return new Response(JSON.stringify({ id: 'chatcmpl-after-oversize', choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    for (let request = 0; request < 2; request += 1) {
      const valid = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': key,
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });

      expect(valid.status).toBe(200);
      expect(valid.headers.get('X-Trace-Flow-Recording')).toBe('true');
      await valid.text();
    }
    await waitForAsyncOps();
  });

  it('rejects an oversized chunked OTLP export while reading the request stream', async () => {
    const key = 'otlp-chunked-oversize-key';
    const orgId = 'org-otlp-chunked-oversize';
    await setupValidApiKey(key, orgId);
    authorizeApiKey(orgId);

    const response = await SELF.fetch('http://localhost/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trace-Flow-Api-Key': key },
      body: chunkedOversizedBody(),
    });

    expect(response.status).toBe(413);
    await response.text();

    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === 'https://convex.test') {
        return Response.json({
          authorized: true,
          expiresAt: Date.now() + 60_000,
          createdAt: 1,
          orgId,
        });
      }
      await request.arrayBuffer();
      return Response.json({ id: 'chatcmpl-after-otlp-oversize', choices: [] });
    });
    for (let request = 0; request < 2; request += 1) {
      const valid = await SELF.fetch('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Api-Key': key,
          Authorization: 'Bearer openai-key',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(valid.headers.get('X-Trace-Flow-Recording')).toBe('true');
      await valid.text();
    }
    await waitForAsyncOps();
  });

  it.each([
    ['provider', 'http://localhost/openai/v1/chat/completions'],
    ['OTLP', 'http://localhost/v1/traces'],
  ])('rejects an unauthenticated oversized %s body before buffering it', async (_name, url) => {
    const response = await SELF.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: chunkedOversizedBody(),
    });

    expect(response.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
