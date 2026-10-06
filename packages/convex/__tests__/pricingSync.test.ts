import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_PRICING_TTL_SECONDS } from '@trace-flow/pricing';
import { internal } from '../_generated/api';
import { initConvexTest } from './convexTest.setup';

const key = { provider: 'openrouter', model: 'example/model' };
const pricing = {
  ...key,
  promptCostPerMillion: 2,
  completionCostPerMillion: 4,
  source: 'openrouter' as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  vi.stubEnv('CLOUDFLARE_PRICING_KV_NAMESPACE_ID', 'test-namespace');
  vi.stubEnv('CLOUDFLARE_API_BASE_URL', 'https://cloudflare.test');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  const t = initConvexTest();
  await t.mutation(internal.billing.modelPricing.upsertInternal, pricing);
  return t;
}

describe('pricing KV synchronization', () => {
  it.each(['network', 'timeout', 429, 503] as const)(
    'recovers from a transient %s failure',
    async (failure) => {
      const t = await setup();
      const fetchMock = vi.fn().mockResolvedValue(new Response(''));
      if (failure === 'network') fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      else if (failure === 'timeout')
        fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
      else fetchMock.mockResolvedValueOnce(new Response('', { status: failure }));
      vi.stubGlobal('fetch', fetchMock);

      const action = t.action(internal.billing.pricingSync.syncToKV, key);
      const completed = expect(action).resolves.toBeNull();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await vi.runAllTimersAsync();
      await completed;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url, request] = fetchMock.mock.calls[1]!;
      expect(decodeURIComponent(new URL(String(url)).pathname)).toContain(
        'pricing:openrouter:example/model',
      );
      expect(new URL(String(url)).searchParams.get('expiration_ttl')).toBe(
        String(OPENROUTER_PRICING_TTL_SECONDS),
      );
      expect(request.method).toBe('PUT');
      expect(JSON.parse(request.body)).toMatchObject({
        promptCostPerMillion: 2,
        completionCostPerMillion: 4,
        source: 'openrouter',
      });
      expect(request.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it('fails after a bounded number of attempts', async () => {
    const t = await setup();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const action = t.action(internal.billing.pricingSync.syncToKV, key);
    const failed = expect(action).rejects.toThrow('Cloudflare pricing KV request did not complete');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.runAllTimersAsync();
    await failed;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([400, 401, 403])('does not retry a permanent HTTP %s rejection', async (status) => {
    const t = await setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response('rejected', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(t.action(internal.billing.pricingSync.syncToKV, key)).rejects.toThrow(
      String(status),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails immediately for missing configuration', async () => {
    const t = await setup();
    vi.stubEnv('CLOUDFLARE_PRICING_KV_NAMESPACE_ID', undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(t.action(internal.billing.pricingSync.syncToKV, key)).rejects.toThrow(
      'Cloudflare pricing KV environment variables not set',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-reads current pricing after a failure', async () => {
    const t = await setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(''));
    fetchMock.mockImplementationOnce(async () => {
      await t.mutation(internal.billing.modelPricing.upsertInternal, {
        ...pricing,
        promptCostPerMillion: 9,
        source: 'manual',
      });
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const completed = expect(
      t.action(internal.billing.pricingSync.syncToKV, key),
    ).resolves.toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.runAllTimersAsync();
    await completed;
    const [url, request] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(request.body)).toMatchObject({ promptCostPerMillion: 9, source: 'manual' });
    expect(new URL(String(url)).searchParams.has('expiration_ttl')).toBe(false);
  });

  it('stops retrying if pricing was removed', async () => {
    const t = await setup();
    const fetchMock = vi.fn(async () => {
      await t.run(async (ctx) => {
        const row = await ctx.db.query('modelPricing').first();
        await ctx.db.delete(row!._id);
      });
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const completed = expect(
      t.action(internal.billing.pricingSync.syncToKV, key),
    ).resolves.toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.runAllTimersAsync();
    await completed;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes pricing through a real HTTP endpoint after a transient failure', async () => {
    vi.useRealTimers();
    const t = await setup();
    const writes: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        writes.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(writes.length === 1 ? 503 : 200);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP test address');
    vi.stubEnv('CLOUDFLARE_API_BASE_URL', `http://127.0.0.1:${address.port}`);
    try {
      await expect(t.action(internal.billing.pricingSync.syncToKV, key)).resolves.toBeNull();
      expect(writes).toHaveLength(2);
      expect(writes[1]).toMatchObject({
        promptCostPerMillion: 2,
        completionCostPerMillion: 4,
        source: 'openrouter',
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
