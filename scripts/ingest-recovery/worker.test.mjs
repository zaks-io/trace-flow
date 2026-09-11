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

test('returns an allowlisted archive rejection without exposing unknown remote errors', async () => {
  const body = {
    pipeline: 'archive',
    shardId: 'codex:part:primary',
    options: {},
    confirm: 'apply-recovery',
  };
  const known = await worker.fetch(request('applyArchiveRepairChunk', body), {
    ARCHIVE_RECOVERY: {
      applyArchiveRepairChunk: async () => {
        throw new Error('ArchiveContractError: archive_repair_precondition_failed');
      },
    },
  });
  assert.equal(known.status, 409);
  assert.deepEqual(await known.json(), {
    error: 'archive_recovery_rejected',
    reason: 'archive_repair_precondition_failed',
  });

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

  const unknown = await worker.fetch(request('applyArchiveRepairChunk', body), {
    ARCHIVE_RECOVERY: {
      applyArchiveRepairChunk: async () => {
        throw new Error('secret customer payload');
      },
    },
  });
  assert.equal(unknown.status, 502);
  assert.equal(await unknown.text(), 'Recovery failed; inspect the consumer logs');
});
