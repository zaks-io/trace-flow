import {
  createExecutionContext,
  env,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProxyEnv } from '../context';
import type { TraceDeliveryMessage } from '@trace-flow/types';
import worker from '../index';

const bindings = env as unknown as ProxyEnv;
const namespace = bindings.TRACE_DELIVERY_SWEEP;

afterEach(() => vi.restoreAllMocks());

async function setup(overrides: Partial<ProxyEnv> = {}) {
  const name = `sweep-test-${crypto.randomUUID()}`;
  const stub = namespace.get(namespace.idFromName(name));
  const configure = () =>
    runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: ProxyEnv }).env = {
        ...bindings,
        AXIOM_TOKEN: undefined,
        SENTRY_DSN: undefined,
        TRACE_DELIVERY_NAMESPACE: name,
        ...overrides,
      };
    });
  await configure();
  return { name, stub, configure };
}

function loggedEvents(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(
    ([value]) => JSON.parse(String(value)) as { event: string; data: Record<string, unknown> },
  );
}

it('runs the scheduled handler through its coordinator, a transient throttle, real R2, and real Queue publication', async () => {
  const list = vi
    .fn()
    .mockRejectedValueOnce(
      new Error('list: Reduce your concurrent request rate for the same object. (10058)'),
    )
    .mockImplementation((options: R2ListOptions) => bindings.STORAGE.list(options));
  const sendBatch = vi.fn((messages: MessageSendRequest<TraceDeliveryMessage>[]) =>
    bindings.REQUEST_QUEUE.sendBatch(messages),
  );
  const { name } = await setup({
    STORAGE: { list } as unknown as R2Bucket,
    REQUEST_QUEUE: { sendBatch } as unknown as ProxyEnv['REQUEST_QUEUE'],
  });
  const key = `trace-deliveries/${name}-pending`;
  await bindings.STORAGE.put(key, 'retained envelope');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
  const info = vi.spyOn(console, 'info');
  const ctx = createExecutionContext();
  await worker.scheduled(
    { cron: '*/5 * * * *', scheduledTime: Date.now(), noRetry() {} },
    { ...bindings, TRACE_DELIVERY_NAMESPACE: name, SENTRY_DSN: '' },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(list).toHaveBeenCalledTimes(2);
  expect(sendBatch).toHaveBeenCalledWith([{ body: { type: 'delivery', key } }]);
  expect(await (await bindings.STORAGE.get(key))?.text()).toBe('retained envelope');
  expect(loggedEvents(info)).toContainEqual(
    expect.objectContaining({
      event: 'proxy.delivery_sweep_completed',
      data: expect.objectContaining({
        listAttempts: 2,
        throttles: 1,
        pages: 1,
        scanned: 1,
        enqueued: 1,
        environment: name,
      }),
    }),
  );
});

it('resumes after eviction and deletion of the page boundary, and revisits keys inserted before it on the next pass', async () => {
  const list = vi.fn((options: R2ListOptions) => bindings.STORAGE.list({ ...options, limit: 1 }));
  const sendBatch = vi.fn((messages: MessageSendRequest<TraceDeliveryMessage>[]) =>
    bindings.REQUEST_QUEUE.sendBatch(messages),
  );
  const t = await setup({
    STORAGE: { list } as unknown as R2Bucket,
    REQUEST_QUEUE: { sendBatch } as unknown as ProxyEnv['REQUEST_QUEUE'],
  });
  for (const suffix of ['b', 'c', 'd'])
    await bindings.STORAGE.put(`trace-deliveries/${t.name}-${suffix}`, 'retained');
  const now = Date.now() + 600_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  sendBatch.mockImplementationOnce(async (messages) => {
    const response = await bindings.REQUEST_QUEUE.sendBatch(messages);
    clock.mockReturnValue(now + 31_000);
    return response;
  });
  await t.stub.run('*/5 * * * *');
  const position = await runInDurableObject(t.stub, (_instance, state) =>
    state.storage.get<{ startAfter: string }>('position'),
  );
  expect(position?.startAfter).toBe(`trace-deliveries/${t.name}-b`);
  await bindings.STORAGE.delete(position!.startAfter);
  await bindings.STORAGE.put(`trace-deliveries/${t.name}-a`, 'inserted before boundary');
  await evictDurableObject(t.stub);
  await t.configure();
  await t.stub.run('*/5 * * * *');
  expect(list).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ startAfter: position!.startAfter }),
  );
  expect(
    await runInDurableObject(t.stub, (_instance, state) => state.storage.get('position')),
  ).toBeUndefined();
  clock.mockReturnValue(now + 600_000);
  await t.stub.run('*/5 * * * *');
  expect(sendBatch.mock.calls.flatMap(([messages]) => messages.map((m) => m.body))).toContainEqual({
    type: 'delivery',
    key: `trace-deliveries/${t.name}-a`,
  });
});

it('skips an overlapping RPC without starting another listing', async () => {
  const list = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { objects: [], truncated: false, delimitedPrefixes: [] };
  });
  const t = await setup({ STORAGE: { list } as unknown as R2Bucket });
  const info = vi.spyOn(console, 'info');
  const first = t.stub.run('*/5 * * * *');
  await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  await t.stub.run('*/5 * * * *');
  await first;
  expect(list).toHaveBeenCalledOnce();
  expect(loggedEvents(info)).toContainEqual(
    expect.objectContaining({
      event: 'proxy.delivery_sweep_skipped',
      data: expect.objectContaining({ reason: 'already_running' }),
    }),
  );
});

it('logs failed publication metrics and recovers the same page on the next run', async () => {
  const sendBatch = vi
    .fn()
    .mockRejectedValueOnce(new Error('Queue unavailable'))
    .mockImplementation((messages: MessageSendRequest<TraceDeliveryMessage>[]) =>
      bindings.REQUEST_QUEUE.sendBatch(messages),
    );
  const t = await setup({ REQUEST_QUEUE: { sendBatch } as unknown as ProxyEnv['REQUEST_QUEUE'] });
  const key = `trace-deliveries/${t.name}-pending`;
  await bindings.STORAGE.put(key, 'retained');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
  const error = vi.spyOn(console, 'error');
  const failure = await t.stub.run('*/5 * * * *').then(
    () => undefined,
    (error: Error) => error.message,
  );
  expect(failure).toBe('Queue unavailable');
  expect(loggedEvents(error)).toContainEqual(
    expect.objectContaining({
      event: 'proxy.delivery_sweep_failed',
      data: expect.objectContaining({
        listAttempts: 1,
        scanned: 1,
        enqueueFailures: 1,
        stopReason: 'error',
      }),
    }),
  );
  expect(await (await bindings.STORAGE.get(key))?.text()).toBe('retained');
  await t.stub.run('*/5 * * * *');
  expect(sendBatch).toHaveBeenNthCalledWith(2, [{ body: { type: 'delivery', key } }]);
});
