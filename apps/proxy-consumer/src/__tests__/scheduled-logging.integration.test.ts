import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { type Env } from '../index';

const bindings = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());

function pendingResponse() {
  let resolve!: (status: number) => void;
  const promise = new Promise<number>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function beforeUpload<T>(result: Promise<T>): Promise<T | 'upload still blocking'> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      result,
      new Promise<'upload still blocking'>((resolve) => {
        timer = setTimeout(() => resolve('upload still blocking'), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

it.each([false, true])(
  'returns scheduled health check before upload and delivers logs, stats failure=%s',
  async (failStats) => {
    const upload = pendingResponse();
    const delivered: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const response = new Response(null, { status: await upload.promise });
      delivered.push(String(init?.body));
      return response;
    });
    const ctx = createExecutionContext();
    const configured: Env = {
      ...bindings,
      AXIOM_TOKEN: 'test-token',
      SENTRY_DSN: undefined,
      NUM_SHARDS: 1,
      ...(failStats
        ? {
            TRACE_BATCHER: {
              idFromName: (name: string) => bindings.TRACE_BATCHER.idFromName(name),
              get: () => ({
                getStats: async () => {
                  throw new Error('Stats unavailable');
                },
              }),
            } as unknown as Env['TRACE_BATCHER'],
          }
        : {}),
    };
    try {
      expect(
        await beforeUpload(
          worker.scheduled(
            { cron: '*/5 * * * *', scheduledTime: Date.now(), noRetry() {} },
            configured,
            ctx,
          ),
        ),
      ).toBeUndefined();
      expect(fetch).toHaveBeenCalledOnce();
      expect(delivered).toEqual([]);
    } finally {
      upload.resolve(200);
      await waitOnExecutionContext(ctx);
    }
    const records = JSON.parse(delivered[0]!) as { event: string; data: Record<string, unknown> }[];
    expect(records).toContainEqual(
      expect.objectContaining({
        event: 'consumer.trace_batcher_health_check_complete',
        data: expect.objectContaining({ checkedShards: 1, unhealthyShards: failStats ? 1 : 0 }),
      }),
    );
    if (failStats)
      expect(records).toContainEqual(
        expect.objectContaining({ event: 'consumer.trace_batcher_health_check_failed' }),
      );
  },
);

it('reports a failed background upload without rejecting the scheduled handler', async () => {
  const upload = pendingResponse();
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(null, { status: await upload.promise }),
  );
  const error = vi.spyOn(console, 'error');
  const ctx = createExecutionContext();
  try {
    expect(
      await beforeUpload(
        worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: Date.now(), noRetry() {} },
          {
            ...bindings,
            AXIOM_TOKEN: 'test-token',
            SENTRY_DSN: undefined,
            NUM_SHARDS: 1,
          },
          ctx,
        ),
      ),
    ).toBeUndefined();
  } finally {
    upload.resolve(503);
    await waitOnExecutionContext(ctx);
  }
  expect(error.mock.calls.map(([value]) => JSON.parse(String(value)).event)).toContain(
    'logger.axiom_ingest_failed',
  );
});
