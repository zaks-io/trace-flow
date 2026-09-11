import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { ArchiveRecovery } from '../index';
import type { ArchiveApiEnv } from '../context';
import type { ArchiveUploadRequest, CompletedScanCheckpoint } from '../archive-contract';
import { archiveUploadIntentIdentity, parseAndValidateUpload } from '../archive-validation';
import { intentDigest } from '../archive-ledger-support';
import { assertArchiveVerificationComplete } from '../archive-ledger-verification';
import {
  base64,
  call,
  checkpoint,
  digest,
  envelope,
  exactPrefix,
  fallbackArchiveKeyHttp,
  newLedger,
  observation,
  partFor,
  prefixChainHash,
  runtimeEnv,
  scope,
  ARCHIVE_STORAGE_CAP_BYTES,
  MAX_ARCHIVE_UPLOAD_BYTES,
  archiveSessionPrefix,
  readPendingIntent,
} from './ledger.integration.fixtures';
import type { ArchiveSessionLedger } from './ledger.integration.fixtures';

interface Snapshot {
  generation: number;
  elementCount: number;
  recordCount: number;
  chainHead: string;
}

async function uploadDigest(upload: ArchiveUploadRequest, currentScope: ReturnType<typeof scope>) {
  return intentDigest(
    archiveUploadIntentIdentity(await parseAndValidateUpload(upload, currentScope)),
  );
}

async function verifyCompletely(
  recovery: ArchiveRecovery,
  partId: string,
  input: {
    scope: ReturnType<typeof scope>;
    operationId: string;
    snapshotSha256: string;
    phase: 'before' | 'after';
    expected: Snapshot;
  },
) {
  for (let page = 0; page < 100; page += 1) {
    const result = (await recovery.verifyArchiveRepairPage(partId, input)) as {
      status: string;
      nextSequence: number;
      verifiedManifestObjects: number;
    };
    if (result.status === 'complete') return result;
  }
  throw new Error('archive verification did not finish');
}

async function captureLedgerError(
  stub: ReturnType<typeof newLedger>,
  work: (instance: ArchiveSessionLedger) => Promise<unknown>,
): Promise<string | null> {
  return runInDurableObject(stub, async (instance: ArchiveSessionLedger) => {
    try {
      await work(instance);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

describe('operator archive repair', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { orgId?: string } | null;
      const response = await fallbackArchiveKeyHttp(
        new URL(request.url).pathname,
        body?.orgId ?? '',
      );
      if (response) return response;
      throw new Error(`unexpected request: ${new URL(request.url).pathname}`);
    });
  });

  it('rebases a changed prefix, preserves history, applies exact deltas, and finalizes a paged proof', async () => {
    const currentScope = scope('codex', `repair-${crypto.randomUUID()}`);
    const partId = partFor('codex');
    const initialRecords = await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        observation(
          'codex',
          currentScope.sourceSessionId,
          partId,
          `line-${index}`,
          JSON.stringify({ index, version: 1 }),
          1_700_000_000_000 + index,
        ),
      ),
    );
    const initialCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partId,
      initialRecords,
    );
    const initialUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: initialRecords,
      checkpoint: initialCheckpoint,
      complete_prefix_base64: base64(exactPrefix(initialRecords)),
    } satisfies ArchiveUploadRequest;
    const stub = newLedger(currentScope);
    expect((await call(stub, await envelope(currentScope, initialUpload))).response.status).toBe(
      200,
    );
    const originalRows = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ sequence: number; data: string }>(
        'SELECT sequence, data FROM ledger_elements ORDER BY sequence',
      ),
    ]);
    const integrityOperationId = `integrity:${'a'.repeat(64)}`;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO ledger_integrity_state (id, error_class, operation_id) VALUES (1, ?, ?)',
        'checkpoint_prefix_mismatch',
        integrityOperationId,
      );
    });

    const changedFirst = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-0',
      JSON.stringify('x'.repeat(13_655_039)),
      initialRecords[0]!.observed_at,
    );
    expect(new TextEncoder().encode(changedFirst.payload).byteLength).toBe(13_655_041);
    const repairedRecords = [changedFirst, ...initialRecords.slice(1)];
    const rebaseCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partId,
      repairedRecords,
    );
    const rebasePrefix = exactPrefix(repairedRecords);
    const rebaseUpload = {
      archive_upload_wire_version: 2,
      source_session_id: currentScope.sourceSessionId,
      observations: repairedRecords.map(({ payload: _payload, ...metadata }) => metadata),
      checkpoint: rebaseCheckpoint,
      complete_prefix_utf8: new TextDecoder().decode(rebasePrefix),
    } satisfies ArchiveUploadRequest;
    expect(new TextEncoder().encode(JSON.stringify(rebaseUpload)).byteLength).toBeLessThanOrEqual(
      MAX_ARCHIVE_UPLOAD_BYTES,
    );

    const finalRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-257',
      JSON.stringify({ index: 257, version: 1 }),
      1_700_000_000_300,
    );
    const appendedBytes = exactPrefix([finalRecord]);
    const finalCheckpoint = {
      ...(await checkpoint('codex', currentScope.sourceSessionId, partId, [
        ...repairedRecords,
        finalRecord,
      ])),
      prefix_chain_sha256: await prefixChainHash(
        rebaseCheckpoint.prefix_chain_sha256,
        appendedBytes,
      ),
    } satisfies CompletedScanCheckpoint;
    const deltaUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [finalRecord],
      checkpoint: finalCheckpoint,
      prior_checkpoint: rebaseCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: rebaseCheckpoint.prefix_chain_sha256,
        appended_prefix_base64: base64(appendedBytes),
      },
    } satisfies ArchiveUploadRequest;

    const recovery = new ArchiveRecovery(
      createExecutionContext(),
      runtimeEnv as unknown as ArchiveApiEnv,
    );
    const inspected = (await recovery.inspectArchivePart(partId, { scope: currentScope })) as {
      state: Snapshot;
      scan: CompletedScanCheckpoint;
      integrity: { operationId: string } | null;
    };
    expect(inspected.integrity?.operationId).toBe(integrityOperationId);
    const snapshotSha256 = await digest(exactPrefix([...repairedRecords, finalRecord]));
    const malformedReferenceOperation = crypto.randomUUID();
    let malformedProgress: { status: string } = { status: 'ledger' };
    while (malformedProgress.status === 'ledger') {
      malformedProgress = (await recovery.verifyArchiveRepairPage(partId, {
        scope: currentScope,
        operationId: malformedReferenceOperation,
        snapshotSha256,
        phase: 'before',
        expected: inspected.state,
      })) as { status: string };
    }
    expect(malformedProgress.status).toBe('manifest');
    expect(
      await recovery.verifyArchiveRepairPage(partId, {
        scope: currentScope,
        operationId: malformedReferenceOperation,
        snapshotSha256,
        phase: 'before',
        expected: inspected.state,
      }),
    ).toMatchObject({ status: 'manifest' });
    await runInDurableObject(stub, (_instance, state) => {
      const pending = [
        ...state.storage.sql.exec<{ object_key: string; data: string }>(
          "SELECT object_key, data FROM ledger_verification_objects WHERE operation_id = ? AND phase = 'before' AND status = 'pending' LIMIT 1",
          malformedReferenceOperation,
        ),
      ][0];
      if (!pending) throw new Error('referenced manifest page missing');
      const expected = JSON.parse(pending.data) as { cumulativeElementCount: number };
      state.storage.sql.exec(
        "UPDATE ledger_verification_objects SET data = ? WHERE operation_id = ? AND phase = 'before' AND object_key = ?",
        JSON.stringify({
          kind: 'history',
          cumulativeElementCount: expected.cumulativeElementCount - 1,
        }),
        malformedReferenceOperation,
        pending.object_key,
      );
    });
    expect(
      await captureLedgerError(stub, (instance) =>
        instance.verifyArchiveRepairPage({
          scope: currentScope,
          operationId: malformedReferenceOperation,
          snapshotSha256,
          phase: 'before',
          expected: inspected.state,
        }),
      ),
    ).toBe('archive_verification_manifest_invalid');

    const operationId = crypto.randomUUID();
    const chunkDigests = [
      await uploadDigest(rebaseUpload, currentScope),
      await uploadDigest(deltaUpload, currentScope),
    ];
    const plan = {
      expectedBase: inspected.state,
      expectedScan: inspected.scan,
      expectedIntegrityOperationId: integrityOperationId,
      finalCheckpoint,
      snapshotSha256,
      reason: 'Restore the exact changed source prefix from the immutable operator snapshot',
      chunkDigests,
    };
    const before = await verifyCompletely(recovery, partId, {
      scope: currentScope,
      operationId,
      snapshotSha256,
      phase: 'before',
      expected: inspected.state,
    });
    expect(before.nextSequence).toBe(inspected.state.elementCount);
    expect(before.verifiedManifestObjects).toBeGreaterThan(1);

    expect(
      await captureLedgerError(stub, (instance) =>
        instance.applyArchiveRepairChunk({
          scope: currentScope,
          upload: rebaseUpload,
          operationId,
          plan: { ...plan, expectedIntegrityOperationId: null },
          expected: inspected.state,
          chunkIndex: 0,
          chunkKind: 'rebase',
        }),
      ),
    ).toBe('archive_repair_precondition_failed');

    const tamperedUpload = {
      ...rebaseUpload,
      complete_prefix_utf8: rebaseUpload.complete_prefix_utf8.replace('"x', '"y'),
    };
    expect(
      await captureLedgerError(stub, (instance) =>
        instance.applyArchiveRepairChunk({
          scope: currentScope,
          upload: tamperedUpload,
          operationId,
          plan,
          expected: inspected.state,
          chunkIndex: 0,
          chunkKind: 'rebase',
        }),
      ),
    ).toBe('payload_hash_mismatch');

    expect(
      await captureLedgerError(stub, (instance) =>
        instance.applyArchiveRepairChunk({
          scope: currentScope,
          upload: rebaseUpload,
          operationId,
          plan,
          expected: { ...inspected.state, generation: inspected.state.generation + 1 },
          chunkIndex: 0,
          chunkKind: 'rebase',
        }),
      ),
    ).toBe('archive_repair_precondition_failed');

    const firstAck = (await recovery.applyArchiveRepairChunk(partId, {
      scope: currentScope,
      upload: rebaseUpload,
      operationId,
      plan,
      expected: inspected.state,
      chunkIndex: 0,
      chunkKind: 'rebase',
    })) as Record<string, unknown>;
    expect(
      await recovery.applyArchiveRepairChunk(partId, {
        scope: currentScope,
        upload: rebaseUpload,
        operationId,
        plan,
        expected: inspected.state,
        chunkIndex: 0,
        chunkKind: 'rebase',
      }),
    ).toEqual(firstAck);

    const blocked = await call(stub, await envelope(currentScope, initialUpload));
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toEqual({ error: 'archive_repair_in_progress' });

    const afterRebase = (await recovery.inspectArchivePart(partId, {
      scope: currentScope,
    })) as { state: Snapshot; integrity: unknown };
    expect(afterRebase.integrity).toBeNull();
    expect(
      await captureLedgerError(stub, (instance) =>
        instance.applyArchiveRepairChunk({
          scope: currentScope,
          upload: deltaUpload,
          operationId,
          plan: { ...plan, reason: 'changed plan must not reuse the operation id' },
          expected: afterRebase.state,
          chunkIndex: 1,
          chunkKind: 'delta',
        }),
      ),
    ).toBe('archive_repair_plan_mismatch');
    const finalAck = (await recovery.applyArchiveRepairChunk(partId, {
      scope: currentScope,
      upload: deltaUpload,
      operationId,
      plan,
      expected: afterRebase.state,
      chunkIndex: 1,
      chunkKind: 'delta',
    })) as Record<string, unknown>;
    const finalState: Snapshot = {
      generation: finalAck.generation as number,
      elementCount: afterRebase.state.elementCount + 2,
      recordCount: finalAck.record_count as number,
      chainHead: finalAck.chain_head as string,
    };
    const prematureFinalize = await runInDurableObject(stub, (_instance, state) => {
      try {
        assertArchiveVerificationComplete(
          state.storage,
          operationId,
          'after',
          snapshotSha256,
          finalState,
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(prematureFinalize).toBe('archive_verification_required');
    const post = await verifyCompletely(recovery, partId, {
      scope: currentScope,
      operationId,
      snapshotSha256,
      phase: 'after',
      expected: finalState,
    });
    expect(post.verifiedManifestObjects).toBeGreaterThan(1);
    expect(
      await recovery.finalizeArchiveRepair(partId, {
        scope: currentScope,
        operationId,
        snapshotSha256,
        expected: finalState,
      }),
    ).toMatchObject({ status: 'finalized', replay: false });

    const liveRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-258',
      JSON.stringify({ index: 258, version: 1 }),
      1_700_000_000_301,
    );
    const liveBytes = exactPrefix([liveRecord]);
    const liveCheckpoint = {
      ...(await checkpoint('codex', currentScope.sourceSessionId, partId, [
        ...repairedRecords,
        finalRecord,
        liveRecord,
      ])),
      prefix_chain_sha256: await prefixChainHash(finalCheckpoint.prefix_chain_sha256, liveBytes),
    };
    const live = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [liveRecord],
        checkpoint: liveCheckpoint,
        prior_checkpoint: finalCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: finalCheckpoint.prefix_chain_sha256,
          appended_prefix_base64: base64(liveBytes),
        },
      }),
    );
    expect(live.response.status).toBe(200);

    const persisted = await runInDurableObject(stub, (_instance, state) => ({
      oldRows: [
        ...state.storage.sql.exec<{ sequence: number; data: string }>(
          'SELECT sequence, data FROM ledger_elements WHERE sequence < ? ORDER BY sequence',
          originalRows.length,
        ),
      ],
      versions: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_record_versions',
        ),
      ][0]?.count,
      repair: [
        ...state.storage.sql.exec<{ status: string }>(
          'SELECT status FROM ledger_repairs WHERE operation_id = ?',
          operationId,
        ),
      ][0]?.status,
      preservedFingerprints: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_repair_fingerprints WHERE operation_id = ?',
          operationId,
        ),
      ][0]?.count,
    }));
    expect(persisted.oldRows).toEqual(originalRows);
    expect(persisted.versions).toBe(260);
    expect(persisted.repair).toBe('finalized');
    expect(persisted.preservedFingerprints).toBe(257);
  });

  it('bounds a verification page by retained plaintext for compressed large chunks', async () => {
    const currentScope = scope('codex', `repair-memory-${crypto.randomUUID()}`);
    const partId = partFor('codex');
    const stub = newLedger(currentScope);
    const records = [];
    let prior: CompletedScanCheckpoint | undefined;
    const payload = JSON.stringify('x'.repeat(13_655_039));
    expect(new TextEncoder().encode(payload).byteLength).toBe(13_655_041);
    for (let index = 0; index < 3; index += 1) {
      const record = await observation(
        'codex',
        currentScope.sourceSessionId,
        partId,
        `large-${index}`,
        payload,
        1_700_000_001_000 + index,
      );
      records.push(record);
      const proof = exactPrefix([record]);
      const next = {
        ...(await checkpoint('codex', currentScope.sourceSessionId, partId, records)),
        ...(prior
          ? { prefix_chain_sha256: await prefixChainHash(prior.prefix_chain_sha256, proof) }
          : {}),
      };
      const { payload: _payload, ...metadata } = record;
      const upload: ArchiveUploadRequest = prior
        ? {
            archive_upload_wire_version: 2,
            source_session_id: currentScope.sourceSessionId,
            observations: [metadata],
            checkpoint: next,
            prior_checkpoint: prior,
            append_proof: {
              prior_prefix_chain_sha256: prior.prefix_chain_sha256,
              appended_prefix_utf8: `${record.payload}\n`,
            },
          }
        : {
            archive_upload_wire_version: 2,
            source_session_id: currentScope.sourceSessionId,
            observations: [metadata],
            checkpoint: next,
            complete_prefix_utf8: `${record.payload}\n`,
          };
      const committed = await call(stub, await envelope(currentScope, upload));
      expect(committed.response.status, JSON.stringify(committed.body)).toBe(200);
      prior = next;
    }

    const recovery = new ArchiveRecovery(
      createExecutionContext(),
      runtimeEnv as unknown as ArchiveApiEnv,
    );
    const inspected = (await recovery.inspectArchivePart(partId, { scope: currentScope })) as {
      state: Snapshot;
    };
    const result = (await recovery.verifyArchiveRepairPage(partId, {
      scope: currentScope,
      operationId: crypto.randomUUID(),
      snapshotSha256: await digest(new TextEncoder().encode('large-chunk-snapshot')),
      phase: 'before',
      expected: inspected.state,
      limit: 64,
    })) as { status: string; nextSequence: number };
    expect(result).toEqual(expect.objectContaining({ status: 'ledger', nextSequence: 4 }));
  }, 30_000);

  it('leaves no repair audit or fence when storage capacity rejects the first chunk', async () => {
    const currentScope = scope('codex', `repair-cap-${crypto.randomUUID()}`);
    const partId = partFor('codex');
    const original = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-0',
      '{"version":1}',
    );
    const initialCheckpoint = await checkpoint('codex', currentScope.sourceSessionId, partId, [
      original,
    ]);
    const initialUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [original],
      checkpoint: initialCheckpoint,
      complete_prefix_base64: base64(exactPrefix([original])),
    } satisfies ArchiveUploadRequest;
    const stub = newLedger(currentScope);
    expect((await call(stub, await envelope(currentScope, initialUpload))).response.status).toBe(
      200,
    );
    const changed = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-0',
      '{"version":2}',
    );
    const repairCheckpoint = await checkpoint('codex', currentScope.sourceSessionId, partId, [
      changed,
    ]);
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [changed],
      checkpoint: repairCheckpoint,
      complete_prefix_base64: base64(exactPrefix([changed])),
    } satisfies ArchiveUploadRequest;
    const recovery = new ArchiveRecovery(
      createExecutionContext(),
      runtimeEnv as unknown as ArchiveApiEnv,
    );
    const inspected = (await recovery.inspectArchivePart(partId, { scope: currentScope })) as {
      state: Snapshot;
      scan: CompletedScanCheckpoint;
    };
    const operationId = crypto.randomUUID();
    const snapshotSha256 = await digest(exactPrefix([changed]));
    await verifyCompletely(recovery, partId, {
      scope: currentScope,
      operationId,
      snapshotSha256,
      phase: 'before',
      expected: inspected.state,
    });
    const repairDigest = await uploadDigest(upload, currentScope);
    const plan = {
      expectedBase: inspected.state,
      expectedScan: inspected.scan,
      expectedIntegrityOperationId: null,
      finalCheckpoint: repairCheckpoint,
      snapshotSha256,
      reason: 'capacity negative control',
      chunkDigests: [repairDigest],
    };
    expect(
      await captureLedgerError(stub, (instance) =>
        instance.applyArchiveRepairChunk({
          scope: currentScope,
          upload: {
            ...upload,
            ignored_padding: 'x'.repeat(MAX_ARCHIVE_UPLOAD_BYTES),
          } as unknown as ArchiveUploadRequest,
          operationId,
          plan,
          expected: inspected.state,
          chunkIndex: 0,
          chunkKind: 'rebase',
        }),
      ),
    ).toBe('upload_too_large');
    const budget = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    const currentBudget = await budget.getStorageBudget({ orgId: currentScope.orgId });
    expect(currentBudget.availableBytes).toBeLessThan(ARCHIVE_STORAGE_CAP_BYTES);
    await budget.reserveStorage({
      orgId: currentScope.orgId,
      objects: [
        {
          objectKey: `test/filler-${crypto.randomUUID()}`,
          objectClass: 'agent_archive_chunk',
          bytes: currentBudget.availableBytes,
          expiresAt: null,
          keyVersion: 1,
        },
      ],
    });
    expect(
      await captureLedgerError(stub, (instance) =>
        instance.applyArchiveRepairChunk({
          scope: currentScope,
          upload,
          operationId,
          plan,
          expected: inspected.state,
          chunkIndex: 0,
          chunkKind: 'rebase',
        }),
      ),
    ).toBe('storage_cap_exceeded');
    const repairRows = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec('SELECT operation_id FROM ledger_repairs'),
    ]);
    expect(repairRows).toEqual([]);
  });

  it('reconciles a foreign write-authorized intent before rejecting a stale repair plan', async () => {
    const currentScope = scope('codex', `repair-pending-${crypto.randomUUID()}`);
    const partId = partFor('codex');
    const original = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-0',
      '{"version":1}',
    );
    const initialCheckpoint = await checkpoint('codex', currentScope.sourceSessionId, partId, [
      original,
    ]);
    const stub = newLedger(currentScope);
    expect(
      (
        await call(
          stub,
          await envelope(currentScope, {
            source_session_id: currentScope.sourceSessionId,
            observations: [original],
            checkpoint: initialCheckpoint,
            complete_prefix_base64: base64(exactPrefix([original])),
          }),
        )
      ).response.status,
    ).toBe(200);
    const recovery = new ArchiveRecovery(
      createExecutionContext(),
      runtimeEnv as unknown as ArchiveApiEnv,
    );
    const inspected = (await recovery.inspectArchivePart(partId, { scope: currentScope })) as {
      state: Snapshot;
      scan: CompletedScanCheckpoint;
    };
    const changed = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-0',
      '{"version":2}',
    );
    const repairCheckpoint = await checkpoint('codex', currentScope.sourceSessionId, partId, [
      changed,
    ]);
    const repairUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [changed],
      checkpoint: repairCheckpoint,
      complete_prefix_base64: base64(exactPrefix([changed])),
    } satisfies ArchiveUploadRequest;
    const operationId = crypto.randomUUID();
    const snapshotSha256 = await digest(exactPrefix([changed]));
    await verifyCompletely(recovery, partId, {
      scope: currentScope,
      operationId,
      snapshotSha256,
      phase: 'before',
      expected: inspected.state,
    });

    const appended = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-1',
      '{"version":1}',
    );
    const appendedBytes = exactPrefix([appended]);
    const advancedCheckpoint = {
      ...(await checkpoint('codex', currentScope.sourceSessionId, partId, [original, appended])),
      prefix_chain_sha256: await prefixChainHash(
        initialCheckpoint.prefix_chain_sha256,
        appendedBytes,
      ),
    };
    const pendingEnvelope = await envelope(currentScope, {
      source_session_id: currentScope.sourceSessionId,
      observations: [appended],
      checkpoint: advancedCheckpoint,
      prior_checkpoint: initialCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: initialCheckpoint.prefix_chain_sha256,
        appended_prefix_base64: base64(appendedBytes),
      },
    });
    let interrupted = false;
    const interruptedBucket = {
      get: (key: string) => runtimeEnv.ARCHIVE_STORAGE.get(key),
      head: (key: string) => runtimeEnv.ARCHIVE_STORAGE.head(key),
      put: async (key: string, body: string, options?: R2PutOptions) => {
        const result = await runtimeEnv.ARCHIVE_STORAGE.put(key, body, options);
        if (!interrupted) {
          interrupted = true;
          throw new Error('foreign_write_interrupted');
        }
        return result;
      },
    } as unknown as R2Bucket;
    await runInDurableObject(stub, (instance: ArchiveSessionLedger) => {
      (instance as unknown as { env: ArchiveApiEnv }).env = {
        ...(runtimeEnv as unknown as ArchiveApiEnv),
        ARCHIVE_STORAGE: interruptedBucket,
      };
    });
    expect(
      await captureLedgerError(stub, (instance) =>
        instance.fetch(
          new Request('https://ledger.test/commit', {
            method: 'POST',
            body: JSON.stringify(pendingEnvelope),
          }),
        ),
      ),
    ).toBe('foreign_write_interrupted');
    expect(
      await runInDurableObject(stub, (_instance, state) => readPendingIntent(state.storage)),
    ).toMatchObject({ status: 'write_authorized' });

    await runInDurableObject(stub, (instance: ArchiveSessionLedger) => {
      (instance as unknown as { env: ArchiveApiEnv }).env = runtimeEnv as unknown as ArchiveApiEnv;
    });
    const repairDigest = await uploadDigest(repairUpload, currentScope);
    expect(
      await captureLedgerError(stub, (instance) =>
        instance.applyArchiveRepairChunk({
          scope: currentScope,
          upload: repairUpload,
          operationId,
          plan: {
            expectedBase: inspected.state,
            expectedScan: inspected.scan,
            expectedIntegrityOperationId: null,
            finalCheckpoint: repairCheckpoint,
            snapshotSha256,
            reason: 'foreign pending intent stale-plan control',
            chunkDigests: [repairDigest],
          },
          expected: inspected.state,
          chunkIndex: 0,
          chunkKind: 'rebase',
        }),
      ),
    ).toBe('archive_repair_precondition_failed');
    expect(await recovery.inspectArchivePart(partId, { scope: currentScope })).toMatchObject({
      state: { generation: inspected.state.generation + 1 },
      scan: advancedCheckpoint,
      pendingIntent: null,
      activeRepair: null,
    });
  });

  it.each(['chunk', 'manifest-page'] as const)(
    'fails verification for a corrupt encrypted %s object',
    async (objectClass) => {
      const currentScope = scope('codex', `repair-corrupt-${objectClass}-${crypto.randomUUID()}`);
      const partId = partFor('codex');
      const count = objectClass === 'manifest-page' ? 257 : 1;
      const records = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          observation(
            'codex',
            currentScope.sourceSessionId,
            partId,
            `line-${index}`,
            JSON.stringify({ index }),
          ),
        ),
      );
      const completed = await checkpoint('codex', currentScope.sourceSessionId, partId, records);
      const upload = {
        source_session_id: currentScope.sourceSessionId,
        observations: records,
        checkpoint: completed,
        complete_prefix_base64: base64(exactPrefix(records)),
      } satisfies ArchiveUploadRequest;
      const stub = newLedger(currentScope);
      expect((await call(stub, await envelope(currentScope, upload))).response.status).toBe(200);
      const state = await runInDurableObject(stub, (_instance, durableState) => {
        const row = [
          ...durableState.storage.sql.exec<{ data: string }>(
            'SELECT data FROM ledger_state WHERE id = 1',
          ),
        ][0];
        return JSON.parse(row!.data) as Snapshot & { manifestKey: string };
      });
      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      const corruptKey =
        objectClass === 'chunk'
          ? listed.objects.find((object) => object.key.includes('/chunks/'))?.key
          : listed.objects.find(
              (object) => object.key.includes('/manifests/') && object.key !== state.manifestKey,
            )?.key;
      if (!corruptKey) throw new Error('archive object missing');
      await runtimeEnv.ARCHIVE_STORAGE.put(corruptKey, '{}');
      const input = {
        scope: currentScope,
        operationId: crypto.randomUUID(),
        snapshotSha256: await digest(exactPrefix(records)),
        phase: 'before' as const,
        expected: state,
      };
      let rejected: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        rejected = await captureLedgerError(stub, (instance) =>
          instance.verifyArchiveRepairPage(input),
        );
        if (rejected) break;
      }
      expect(rejected).toBe('archive_verification_object_invalid');
    },
  );

  it('alarm recovery commits the authenticated repair after a write-authorized crash', async () => {
    const currentScope = scope('codex', `repair-alarm-${crypto.randomUUID()}`);
    const partId = partFor('codex');
    const original = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-0',
      '{"version":1}',
    );
    const firstCheckpoint = await checkpoint('codex', currentScope.sourceSessionId, partId, [
      original,
    ]);
    const firstUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [original],
      checkpoint: firstCheckpoint,
      complete_prefix_base64: base64(exactPrefix([original])),
    } satisfies ArchiveUploadRequest;
    const stub = newLedger(currentScope);
    expect((await call(stub, await envelope(currentScope, firstUpload))).response.status).toBe(200);
    const changed = await observation(
      'codex',
      currentScope.sourceSessionId,
      partId,
      'line-0',
      '{"version":2}',
    );
    const changedCheckpoint = await checkpoint('codex', currentScope.sourceSessionId, partId, [
      changed,
    ]);
    const repairUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [changed],
      checkpoint: changedCheckpoint,
      complete_prefix_base64: base64(exactPrefix([changed])),
    } satisfies ArchiveUploadRequest;
    const recovery = new ArchiveRecovery(
      createExecutionContext(),
      runtimeEnv as unknown as ArchiveApiEnv,
    );
    const inspected = (await recovery.inspectArchivePart(partId, { scope: currentScope })) as {
      state: Snapshot;
      scan: CompletedScanCheckpoint;
    };
    const operationId = crypto.randomUUID();
    const snapshotSha256 = await digest(exactPrefix([changed]));
    await verifyCompletely(recovery, partId, {
      scope: currentScope,
      operationId,
      snapshotSha256,
      phase: 'before',
      expected: inspected.state,
    });

    let blocked = true;
    let interruptedKey: string | undefined;
    const interruptedBucket = {
      get: async (key: string) => {
        if (blocked && key === interruptedKey) throw new Error('interrupted_r2_read');
        return runtimeEnv.ARCHIVE_STORAGE.get(key);
      },
      head: (key: string) => runtimeEnv.ARCHIVE_STORAGE.head(key),
      put: async (key: string, body: string, options?: R2PutOptions) => {
        const result = await runtimeEnv.ARCHIVE_STORAGE.put(key, body, options);
        if (!interruptedKey) {
          interruptedKey = key;
          throw new Error('crash_after_write_authorized');
        }
        return result;
      },
    } as unknown as R2Bucket;
    await runInDurableObject(stub, (instance: ArchiveSessionLedger) => {
      (instance as unknown as { env: ArchiveApiEnv }).env = {
        ...(runtimeEnv as unknown as ArchiveApiEnv),
        ARCHIVE_STORAGE: interruptedBucket,
      };
    });
    const repairDigest = await uploadDigest(repairUpload, currentScope);
    expect(
      await captureLedgerError(stub, (instance) =>
        instance.applyArchiveRepairChunk({
          scope: currentScope,
          upload: repairUpload,
          operationId,
          plan: {
            expectedBase: inspected.state,
            expectedScan: inspected.scan,
            expectedIntegrityOperationId: null,
            finalCheckpoint: changedCheckpoint,
            snapshotSha256,
            reason: 'alarm recovery negative response control',
            chunkDigests: [repairDigest],
          },
          expected: inspected.state,
          chunkIndex: 0,
          chunkKind: 'rebase',
        }),
      ),
    ).toBe('crash_after_write_authorized');
    const pending = await runInDurableObject(stub, (_instance, state) =>
      readPendingIntent(state.storage),
    );
    expect(pending).toMatchObject({ status: 'write_authorized' });

    blocked = false;
    await runInDurableObject(stub, async (instance: ArchiveSessionLedger) => {
      (instance as unknown as { env: ArchiveApiEnv }).env = runtimeEnv as unknown as ArchiveApiEnv;
      await instance.alarm();
    });
    expect(await recovery.inspectArchivePart(partId, { scope: currentScope })).toMatchObject({
      state: { generation: inspected.state.generation + 1 },
      activeRepair: { status: 'active', appliedChunks: 1 },
      pendingIntent: null,
    });
  });
});
