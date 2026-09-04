import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker.mjs';

const request = (method, body, headers = {}) =>
  new Request(`http://127.0.0.1:8799/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('returns full recovery payload from the selected private service', async () => {
  const payload = 'x'.repeat(100_000);
  const response = await worker.fetch(
    request('listRecovery', { pipeline: 'proxy', shardId: '3', options: { afterId: 7 } }),
    {
      PROXY_RECOVERY: {
        listRecovery: async (shard, options) => {
          assert.equal(shard, '3');
          assert.deepEqual(options, { afterId: 7 });
          return { records: [{ payload }], nextAfterId: null };
        },
      },
    },
  );
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).records[0].payload, payload);
});

test('does not mutate on browser requests or missing confirmation', async () => {
  const env = {
    PROXY_RECOVERY: {
      reconcileRecovery() {
        assert.fail('must not call');
      },
    },
  };
  const body = { pipeline: 'proxy', shardId: '0' };
  assert.equal((await worker.fetch(request('reconcileRecovery', body), env)).status, 400);
  assert.equal(
    (
      await worker.fetch(
        request(
          'reconcileRecovery',
          { ...body, confirm: 'apply-recovery' },
          { Origin: 'https://example.com' },
        ),
        env,
      )
    ).status,
    403,
  );
});

test('forwards confirmed reconciliation to the agent service', async () => {
  const options = {
    recoveryId: 1,
    action: 'confirm-not-written',
    reason: 'Verified absent in Tinybird',
  };
  const response = await worker.fetch(
    request('reconcileRecovery', {
      pipeline: 'agent',
      shardId: 'org-test',
      options,
      confirm: 'apply-recovery',
    }),
    {
      AGENT_RECOVERY: {
        reconcileRecovery: async (shard, input) => {
          assert.equal(shard, 'org-test');
          assert.deepEqual(input, options);
          return { state: 'resolved' };
        },
      },
    },
  );
  assert.equal(response.status, 200);
});
