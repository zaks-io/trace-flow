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

test('fact rebuild methods require agent pipeline and explicit mutation confirmation', async () => {
  let calls = 0;
  const env = {
    AGENT_RECOVERY: {
      beginFactRebuild: async () => {
        calls++;
        return { status: 'quiescent' };
      },
    },
  };
  const body = {
    pipeline: 'agent',
    shardId: 'org-1',
    options: { operationId: 'op-1', reason: 'verified' },
  };
  assert.equal((await worker.fetch(request('beginFactRebuild', body), env)).status, 400);
  assert.equal(
    (
      await worker.fetch(
        request('beginFactRebuild', { ...body, pipeline: 'proxy', confirm: 'apply-recovery' }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (await worker.fetch(request('beginFactRebuild', { ...body, confirm: 'apply-recovery' }), env))
      .status,
    200,
  );
  assert.equal(calls, 1);
});

test('legacy retirement requires explicit mutation confirmation', async () => {
  const calls = [];
  const env = {
    AGENT_RECOVERY: {
      retireFrozenLedger: async (orgId, proof) => {
        calls.push([orgId, proof]);
        return { ...proof, state: 'complete', completedAtMs: 1 };
      },
    },
  };
  const options = {
    verificationSha256: 'a'.repeat(64),
    migrationProofSha256: 'b'.repeat(64),
    deliverySequence: 42,
    oldestDay: '2025-09-14',
    todayDay: '2026-09-13',
    frozenFactCount: 9,
  };
  const body = { pipeline: 'agent', shardId: 'org-1', options };

  assert.equal((await worker.fetch(request('retireFrozenLedger', body), env)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(
    (await worker.fetch(request('retireFrozenLedger', { ...body, confirm: 'apply-recovery' }), env))
      .status,
    200,
  );
  assert.deepEqual(calls, [['org-1', options]]);
});

test('frozen repair reconciliation requires explicit mutation confirmation', async () => {
  const calls = [];
  const env = {
    AGENT_RECOVERY: {
      reconcileFrozenRepairs: async (orgId, batch) => {
        calls.push([orgId, batch]);
        return { resolved: batch.repairs.length };
      },
    },
  };
  const options = { repairs: [{ recoveryId: 7 }] };
  const body = { pipeline: 'agent', shardId: 'org-1', options };

  assert.equal((await worker.fetch(request('reconcileFrozenRepairs', body), env)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await worker.fetch(
        request('reconcileFrozenRepairs', { ...body, confirm: 'apply-recovery' }),
        env,
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [['org-1', options]]);
});

test('persists the baseline migration window only through a confirmed agent mutation', async () => {
  const calls = [];
  const env = {
    AGENT_RECOVERY: {
      beginBaselineMigrationWindow: async (shardId, options) => {
        calls.push([shardId, options]);
        return options;
      },
    },
  };
  const body = {
    pipeline: 'agent',
    shardId: '__migration__',
    options: { startDay: '2025-09-13', endDay: '2026-09-13' },
  };

  assert.equal(
    (await worker.fetch(request('beginBaselineMigrationWindow', body), env)).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request('beginBaselineMigrationWindow', { ...body, confirm: 'apply-recovery' }),
        env,
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [['__migration__', body.options]]);
});

test('exposes baseline retry only through the confirmed agent recovery service', async () => {
  const calls = [];
  const env = {
    AGENT_RECOVERY: {
      retryBaselineCopy: async (shardId, options) => {
        calls.push([shardId, options]);
        return { ...options, complete: false };
      },
    },
  };
  const options = {
    category: 'tool_events',
    expectedJobId: 'job-failed',
    expectedCopyAttempt: 10,
    nextCopyAttempt: 11,
    observedAt: 11,
    providerErrorSha256: 'a'.repeat(64),
    journalSha256: 'b'.repeat(64),
  };
  const body = { pipeline: 'agent', shardId: 'org-1', options };

  assert.equal((await worker.fetch(request('retryBaselineCopy', body), env)).status, 400);
  assert.equal(
    (
      await worker.fetch(
        request('retryBaselineCopy', { ...body, pipeline: 'proxy', confirm: 'apply-recovery' }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (await worker.fetch(request('retryBaselineCopy', { ...body, confirm: 'apply-recovery' }), env))
      .status,
    200,
  );
  assert.deepEqual(calls, [['org-1', options]]);
});

test('forwards bounded frozen source inspection and reads without mutation confirmation', async () => {
  const calls = [];
  const env = {
    AGENT_RECOVERY: {
      inspectFrozenFactSources: async (shardId, options) => {
        calls.push(['inspect', shardId, options]);
        return [
          { category: 'messages', factId: 'fact', sourceHash: 'a'.repeat(16), payloadBytes: 42 },
        ];
      },
      readFrozenFactSources: async (shardId, options) => {
        calls.push(['read', shardId, options]);
        return [{ category: 'messages', factId: 'fact', payload: '{"private":true}' }];
      },
    },
  };
  const body = {
    pipeline: 'agent',
    shardId: 'org-1',
    options: { facts: [{ category: 'messages', factId: 'fact' }] },
  };

  assert.deepEqual(
    await (await worker.fetch(request('inspectFrozenFactSources', body), env)).json(),
    [{ category: 'messages', factId: 'fact', sourceHash: 'a'.repeat(16), payloadBytes: 42 }],
  );
  assert.deepEqual(await (await worker.fetch(request('readFrozenFactSources', body), env)).json(), [
    { category: 'messages', factId: 'fact', payload: '{"private":true}' },
  ]);
  assert.deepEqual(calls, [
    ['inspect', 'org-1', body.options],
    ['read', 'org-1', body.options],
  ]);
});

test('fact repair inspection is agent-only and compaction requires mutation confirmation', async () => {
  const calls = [];
  const env = {
    AGENT_RECOVERY: {
      inspectFactRepairCapacity: async (shardId, options) => {
        calls.push(['inspect', shardId, options]);
        return { databaseSizeBytes: 10 };
      },
      compactFactRepairDuplicates: async (shardId, options) => {
        calls.push(['compact', shardId, options]);
        return { compacted: [] };
      },
      quiesceFactRepairCapacity: async (shardId, options) => {
        calls.push(['quiesce', shardId, options]);
        return { alarmScheduledAtMs: null };
      },
    },
  };
  const body = {
    pipeline: 'agent',
    shardId: 'org-1',
    options: { candidates: [{ repairId: 1, proofSha256: 'a'.repeat(64) }] },
  };
  const quiescenceBody = {
    ...body,
    options: { expectedAlarmScheduledAtMs: 123, reason: 'clear the exact reviewed alarm' },
  };
  assert.equal((await worker.fetch(request('inspectFactRepairCapacity', body), env)).status, 200);
  assert.equal(
    (await worker.fetch(request('inspectFactRepairCapacity', { ...body, pipeline: 'proxy' }), env))
      .status,
    400,
  );
  assert.equal((await worker.fetch(request('compactFactRepairDuplicates', body), env)).status, 400);
  assert.equal(
    (await worker.fetch(request('quiesceFactRepairCapacity', quiescenceBody), env)).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request('quiesceFactRepairCapacity', {
          ...quiescenceBody,
          pipeline: 'proxy',
          confirm: 'apply-recovery',
        }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request('compactFactRepairDuplicates', { ...body, confirm: 'apply-recovery' }),
        env,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await worker.fetch(
        request('quiesceFactRepairCapacity', {
          ...quiescenceBody,
          confirm: 'apply-recovery',
        }),
        env,
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [
    ['inspect', 'org-1', body.options],
    ['compact', 'org-1', body.options],
    ['quiesce', 'org-1', quiescenceBody.options],
  ]);
});
