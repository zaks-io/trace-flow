import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProxyEnv } from '../context';

const bindings = env as unknown as ProxyEnv;
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

async function setup(list: () => Promise<R2Objects>) {
  const name = `sweep-logging-${crypto.randomUUID()}`;
  const stub = bindings.TRACE_DELIVERY_SWEEP.get(bindings.TRACE_DELIVERY_SWEEP.idFromName(name));
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { env: ProxyEnv }).env = {
      ...bindings,
      AXIOM_TOKEN: 'test-token',
      SENTRY_DSN: undefined,
      TRACE_DELIVERY_NAMESPACE: name,
      STORAGE: { list } as unknown as R2Bucket,
    };
  });
  return stub;
}

function pendingUpload() {
  const response = pendingResponse();
  const delivered: string[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const result = new Response(null, { status: await response.promise });
    if (result.ok) delivered.push(String(init?.body));
    return result;
  });
  return { response, delivered, fetch };
}

const emptyPage = (): R2Objects => ({ objects: [], truncated: false, delimitedPrefixes: [] });

it('returns the sweep RPC before upload, skips overlapping calls through upload, then delivers logs and runs again', async () => {
  const list = vi.fn(async () => emptyPage());
  const stub = await setup(list);
  const upload = pendingUpload();
  try {
    expect(await beforeUpload(stub.run('*/5 * * * *'))).toBeUndefined();
    expect(upload.fetch).toHaveBeenCalledOnce();
    expect(upload.delivered).toEqual([]);
    expect(await beforeUpload(stub.run('*/5 * * * *'))).toBeUndefined();
    expect(list).toHaveBeenCalledOnce();
    expect(upload.fetch).toHaveBeenCalledTimes(2);
  } finally {
    upload.response.resolve(200);
  }
  await vi.waitFor(() => expect(upload.delivered).toHaveLength(2));
  expect(upload.delivered.map((body) => JSON.parse(body)[0].event).sort()).toEqual([
    'proxy.delivery_sweep_completed',
    'proxy.delivery_sweep_skipped',
  ]);
  expect(await beforeUpload(stub.run('*/5 * * * *'))).toBeUndefined();
  expect(list).toHaveBeenCalledTimes(2);
});

it('rejects the failed sweep before upload, retains its checkpoint, and recovers after a failed upload', async () => {
  const list = vi
    .fn()
    .mockRejectedValueOnce(new Error('R2 unavailable'))
    .mockResolvedValue(emptyPage());
  const stub = await setup(list);
  const upload = pendingUpload();
  const errors = vi.spyOn(console, 'error');
  try {
    expect(
      await beforeUpload(
        stub.run('*/5 * * * *').then(
          () => undefined,
          (error: Error) => error.message,
        ),
      ),
    ).toBe('R2 unavailable');
    expect(upload.delivered).toEqual([]);
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.get('position')),
    ).toBeDefined();
    expect(await beforeUpload(stub.run('*/5 * * * *'))).toBeUndefined();
    expect(list).toHaveBeenCalledOnce();
  } finally {
    upload.response.resolve(503);
  }
  await vi.waitFor(() =>
    expect(
      errors.mock.calls.some(
        ([value]) => JSON.parse(String(value)).event === 'logger.axiom_ingest_failed',
      ),
    ).toBe(true),
  );
  expect(await beforeUpload(stub.run('*/5 * * * *'))).toBeUndefined();
  expect(list).toHaveBeenCalledTimes(2);
  expect(
    await runInDurableObject(stub, (_instance, state) => state.storage.get('position')),
  ).toBeUndefined();
});
