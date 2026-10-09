import { test, expect } from 'bun:test';
import {
  cleanupReceipt,
  consumeCleanupApproval,
  recordCleanupSuccess,
} from './tinybird-cleanup-receipt.mjs';
const options = (fetchImpl) => ({
  repository: 'zaks-io/trace-flow',
  token: 'test-only',
  sha: 'a'.repeat(40),
  fetchImpl,
});
test('any durable receipt consumes approval, even without a success status', async () => {
  const receipt = await cleanupReceipt(
    options(async () => Response.json([{ id: 42, task: 'tinybird-cleanup-tra-405' }])),
  );
  expect(receipt.consumed).toBe(true);
});
test('fails closed when the receipt provider cannot be read', async () => {
  await expect(
    cleanupReceipt(options(async () => new Response(null, { status: 403 }))),
  ).rejects.toThrow('HTTP 403');
});
test('consumes approval against the exact commit before applying cleanup', async () => {
  const writes = [];
  const id = await consumeCleanupApproval(
    options(async (url, init) => {
      if (init.method === 'POST') {
        writes.push(JSON.parse(init.body));
        return Response.json({ id: 42 });
      }
      return Response.json([]);
    }),
  );
  expect(id).toBe(42);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    ref: 'a'.repeat(40),
    task: 'tinybird-cleanup-tra-405',
    auto_merge: false,
  });
});
test('does not reuse approval after success recording fails', async () => {
  const fetchImpl = async (url, init) =>
    init.method === 'POST'
      ? new Response(null, { status: 503 })
      : Response.json([{ id: 42, task: 'tinybird-cleanup-tra-405' }]);
  await expect(recordCleanupSuccess(42, options(fetchImpl))).rejects.toThrow('HTTP 503');
  await expect(consumeCleanupApproval(options(fetchImpl))).rejects.toThrow('already consumed');
});
test('records success separately after applying cleanup', async () => {
  const writes = [];
  await recordCleanupSuccess(
    42,
    options(async (url, init) => {
      if (init.method === 'POST') {
        writes.push({ path: url.pathname, body: JSON.parse(init.body) });
        return Response.json({});
      }
      return Response.json([{ id: 42, task: 'tinybird-cleanup-tra-405' }]);
    }),
  );
  expect(writes).toEqual([
    {
      path: '/repos/zaks-io/trace-flow/deployments/42/statuses',
      body: {
        state: 'success',
        environment: 'Production',
        description: 'TRA-405 cleanup applied; original approval cannot be reused',
      },
    },
  ]);
});
