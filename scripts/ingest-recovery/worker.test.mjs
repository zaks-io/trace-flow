import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker.mjs';

const request = (method, body, headers = {}) =>
  new Request(`http://127.0.0.1:8799/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function captureConsoleError(run) {
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    return { result: await run(), logs };
  } finally {
    console.error = originalConsoleError;
  }
}

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

test('archive inspection is read-only while verification and repair require confirmation', async () => {
  const calls = [];
  const env = {
    ARCHIVE_RECOVERY: {
      inspectArchivePart: async (partId, options) => {
        calls.push(['inspect', partId, options]);
        return { generation: 1 };
      },
      verifyArchiveRepairPage: async (partId, options) => {
        calls.push(['verify', partId, options]);
        return { status: 'ledger' };
      },
    },
  };
  const body = {
    pipeline: 'archive',
    shardId: 'codex:part:primary',
    options: { operationId: 'operation-1' },
  };
  assert.equal((await worker.fetch(request('inspectArchivePart', body), env)).status, 200);
  assert.equal((await worker.fetch(request('verifyArchiveRepairPage', body), env)).status, 400);
  assert.equal(
    (
      await worker.fetch(
        request('verifyArchiveRepairPage', { ...body, confirm: 'apply-recovery' }),
        env,
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [
    ['inspect', body.shardId, body.options],
    ['verify', body.shardId, body.options],
  ]);
});

test('forwards confirmed organization budget reads only to archive recovery', async () => {
  const calls = [];
  const orgId = 'k57axc8sefsfp6k28nx6c481js806pwv';
  const env = {
    ARCHIVE_RECOVERY: {
      getStorageBudget: async (shardId, options) => {
        calls.push([shardId, options]);
        return { orgId, admissionUnsafe: true, reservedBytes: 29 };
      },
    },
  };
  const body = { pipeline: 'archive', shardId: orgId, options: { orgId } };

  const response = await worker.fetch(request('getStorageBudget', body), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    orgId,
    admissionUnsafe: true,
    reservedBytes: 29,
  });
  assert.deepEqual(calls, [[orgId, { orgId }]]);
  assert.equal(
    (
      await worker.fetch(request('getStorageBudget', { ...body, pipeline: 'agent' }), {
        AGENT_RECOVERY: env.ARCHIVE_RECOVERY,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request('getStorageBudget', { ...body, options: { orgId: 'different-org' } }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request('getStorageBudget', {
          ...body,
          shardId: 'invalid/org',
          options: { orgId: 'invalid/org' },
        }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(calls.length, 1);

  const uninitialized = await worker.fetch(request('getStorageBudget', body), {
    ARCHIVE_RECOVERY: {
      getStorageBudget: async () => {
        throw new Error('ArchiveContractError: storage_budget_uninitialized');
      },
    },
  });
  assert.equal(uninitialized.status, 409);
  assert.deepEqual(await uninitialized.json(), {
    error: 'archive_recovery_rejected',
    reason: 'storage_budget_uninitialized',
  });
});

test('does not log allowlisted archive rejections and keeps unknown responses generic', async () => {
  const body = {
    pipeline: 'archive',
    shardId: 'codex:part:primary',
    options: {},
    confirm: 'apply-recovery',
  };
  const { result: known, logs: knownLogs } = await captureConsoleError(() =>
    worker.fetch(request('applyArchiveRepairChunk', body), {
      ARCHIVE_RECOVERY: {
        applyArchiveRepairChunk: async () => {
          throw new Error('ArchiveContractError: archive_repair_precondition_failed');
        },
      },
    }),
  );
  assert.equal(known.status, 409);
  assert.deepEqual(await known.json(), {
    error: 'archive_recovery_rejected',
    reason: 'archive_repair_precondition_failed',
  });
  assert.deepEqual(knownLogs, []);

  const invalidPayload = await worker.fetch(request('applyArchiveRepairChunk', body), {
    ARCHIVE_RECOVERY: {
      applyArchiveRepairChunk: async () => {
        throw new Error('ArchiveContractError: payload_hash_mismatch');
      },
    },
  });
  assert.equal(invalidPayload.status, 409);
  assert.deepEqual(await invalidPayload.json(), {
    error: 'archive_recovery_rejected',
    reason: 'payload_hash_mismatch',
  });

  const tooLarge = await worker.fetch(request('applyArchiveRepairChunk', body), {
    ARCHIVE_RECOVERY: {
      applyArchiveRepairChunk: async () => {
        throw new Error('ArchiveContractError: upload_too_large');
      },
    },
  });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), {
    error: 'archive_recovery_rejected',
    reason: 'upload_too_large',
  });

  const unknownError = new Error('secret customer payload');
  const unknownBody = {
    ...body,
    shardId: 'request-only-shard',
    options: { requestOnly: 'request-only-options' },
  };
  const { result: unknown, logs } = await captureConsoleError(() =>
    worker.fetch(request('applyArchiveRepairChunk', unknownBody), {
      ARCHIVE_RECOVERY: {
        applyArchiveRepairChunk: async () => {
          throw unknownError;
        },
      },
    }),
  );
  assert.equal(unknown.status, 502);
  assert.equal(await unknown.text(), 'Recovery failed; inspect the consumer logs');
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], [
    'recovery_bridge_rpc_failed',
    { pipeline: 'archive', method: 'applyArchiveRepairChunk' },
    unknownError,
  ]);
  assert.equal(JSON.stringify(logs[0].slice(0, 2)).includes('request-only'), false);

  const nonErrorSecret = { token: 'non-error-secret' };
  const { result: nonErrorResponse, logs: nonErrorLogs } = await captureConsoleError(() =>
    worker.fetch(request('applyArchiveRepairChunk', body), {
      ARCHIVE_RECOVERY: {
        applyArchiveRepairChunk: async () => {
          throw nonErrorSecret;
        },
      },
    }),
  );
  assert.equal(nonErrorResponse.status, 502);
  assert.equal(await nonErrorResponse.text(), 'Recovery failed; inspect the consumer logs');
  assert.equal(nonErrorLogs.length, 1);
  assert.equal(nonErrorLogs[0][0], 'recovery_bridge_rpc_failed');
  assert.deepEqual(nonErrorLogs[0][1], {
    pipeline: 'archive',
    method: 'applyArchiveRepairChunk',
  });
  assert.equal(nonErrorLogs[0][2] instanceof Error, true);
  assert.equal(nonErrorLogs[0][2].message, 'Recovery RPC threw a non-Error value');
  assert.equal(JSON.stringify(nonErrorLogs[0]).includes(nonErrorSecret.token), false);
});
