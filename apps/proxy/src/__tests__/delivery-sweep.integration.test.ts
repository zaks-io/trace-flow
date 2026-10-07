import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProxyEnv } from '../context';
import type { TraceDeliveryMessage } from '@trace-flow/types';
import worker from '../index';

afterEach(() => vi.restoreAllMocks());

it('runs a scheduled sweep through a transient list throttle using real R2 and Queue bindings', async () => {
  const bindings = env as unknown as ProxyEnv;
  const namespace = `sweep-test-${crypto.randomUUID()}`;
  const key = `trace-deliveries/${namespace}-pending`;
  await env.STORAGE.put(key, 'retained envelope');
  const now = Date.now() + 10 * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const list = vi
    .fn()
    .mockRejectedValueOnce(
      new Error('list: Reduce your concurrent request rate for the same object. (10058)'),
    )
    .mockImplementation((options: R2ListOptions) => env.STORAGE.list(options));
  const send = vi.fn((message: TraceDeliveryMessage) => bindings.REQUEST_QUEUE.send(message));
  const ctx = createExecutionContext();

  try {
    await worker.scheduled(
      { cron: '*/5 * * * *', scheduledTime: now, noRetry() {} },
      {
        ...bindings,
        SENTRY_DSN: '',
        TRACE_DELIVERY_NAMESPACE: namespace,
        STORAGE: { list } as unknown as R2Bucket,
        REQUEST_QUEUE: { send } as unknown as ProxyEnv['REQUEST_QUEUE'],
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(list).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: 'delivery', key });
    expect(await (await env.STORAGE.get(key))?.text()).toBe('retained envelope');
  } finally {
    await env.STORAGE.delete(key);
  }
});
