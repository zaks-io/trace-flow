import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker.mjs';

const request = (method, body, headers = {}) =>
  new Request(`http://127.0.0.1:8799/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('snapshot inspection is read-only and resume requires an agent mutation confirmation', async () => {
  const calls = [];
  const env = {
    AGENT_RECOVERY: {
      inspectDeliveryStatus: async (org, options) => ({ org, options }),
      resumeSnapshot: async (org, options) => {
        calls.push({ org, options });
        return { resumed: true };
      },
    },
  };
  const body = { pipeline: 'agent', shardId: 'org-test', options: {} };
  const inspection = await worker.fetch(request('inspectDeliveryStatus', body), env);
  assert.equal(inspection.status, 200);
  assert.deepEqual(await inspection.json(), { org: 'org-test', options: {} });
  const options = { generation: 7, reason: 'Provider access restored' };
  assert.equal(
    (await worker.fetch(request('resumeSnapshot', { ...body, options }), env)).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request('resumeSnapshot', {
          ...body,
          pipeline: 'proxy',
          options,
          confirm: 'apply-recovery',
        }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(calls.length, 0);
  const resumed = await worker.fetch(
    request('resumeSnapshot', {
      ...body,
      options,
      confirm: 'apply-recovery',
    }),
    env,
  );
  assert.equal(resumed.status, 200);
  assert.deepEqual(calls, [{ org: 'org-test', options }]);
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

test('forwards proxy dead-letter replay only with mutation confirmation', async () => {
  const calls = [];
  const env = {
    PROXY_RECOVERY: {
      replayDlq: async (shardId, options) => {
        calls.push([shardId, options]);
        return { replayed: true };
      },
    },
  };
  const options = { recoveryId: 7, reason: 'Verified delivery can resume' };
  const body = { pipeline: 'proxy', shardId: '3', options };
  assert.equal((await worker.fetch(request('replayDlq', body), env)).status, 400);
  assert.deepEqual(calls, []);

  const response = await worker.fetch(
    request('replayDlq', { ...body, confirm: 'apply-recovery' }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { replayed: true });
  assert.deepEqual(calls, [['3', options]]);
});

test('rejects agent dead-letter replay before calling a recovery service', async () => {
  const response = await worker.fetch(
    request('replayDlq', {
      pipeline: 'agent',
      shardId: 'org-test',
      options: { recoveryId: 7 },
      confirm: 'apply-recovery',
    }),
    {
      AGENT_RECOVERY: {
        replayDlq() {
          assert.fail('must not call');
        },
      },
    },
  );
  assert.equal(response.status, 400);
  assert.equal(
    await response.text(),
    'Recovery method replayDlq is not offered by the agent pipeline',
  );
});

test('guards local JSON requests and rejects unknown methods', async () => {
  const env = {
    PROXY_RECOVERY: {
      listRecovery() {
        assert.fail('must not call');
      },
    },
  };
  const body = { pipeline: 'proxy', shardId: '3' };
  assert.equal(
    (
      await worker.fetch(
        new Request('https://example.com/listRecovery', request('listRecovery', body)),
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (await worker.fetch(new Request('http://127.0.0.1:8799/listRecovery'), env)).status,
    400,
  );
  assert.equal(
    (await worker.fetch(request('listRecovery', body, { 'Content-Type': 'text/plain' }), env))
      .status,
    400,
  );
  assert.equal((await worker.fetch(request('unknown', body), env)).status, 404);
  assert.equal(
    (await worker.fetch(request('listRecovery', { pipeline: 'other', shardId: '3' }), env)).status,
    400,
  );
  assert.equal(
    (await worker.fetch(request('listRecovery', { pipeline: 'proxy' }), env)).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request('http://127.0.0.1:8799/listRecovery', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }),
        env,
      )
    ).status,
    400,
  );
});
