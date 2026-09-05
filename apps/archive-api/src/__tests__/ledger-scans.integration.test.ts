import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
  decryptArchiveObject,
  sha256Hex,
  unwrapArchiveEncryptionKey,
  checkpointChainHash,
  recordChainHash,
  archiveSessionPrefix,
  app,
  prefixChainHash,
  MAX_ARCHIVE_UPLOAD_BYTES,
  commitArchiveSession,
  readLedgerScan,
  readLedgerSnapshot,
  WRAPPING_SECRET,
  KEY_VERSION,
  runtimeEnv,
  partFor,
  base64,
  exactPrefix,
  digest,
  observation,
  checkpoint,
  archiveKey,
  fallbackArchiveKeyHttp,
  scope,
  envelope,
  call,
  newLedger,
  expectIntegrity,
} from './ledger.integration.fixtures';
import type {
  ArchiveUploadRequest,
  CompletedScanCheckpoint,
  ArchiveApiEnv,
} from './ledger.integration.fixtures';

describe('Archive Session Ledger', () => {
  beforeEach(() => {
    expect(runtimeEnv.ARCHIVE_KEY_WRAPPING_SECRET).toBe(WRAPPING_SECRET);
  });

  it('reads one requested Claude checkpoint part without scanning the part table', async () => {
    const currentScope = scope('claude', `targeted-scan-${crypto.randomUUID()}`);
    const targetPart = `claude:part:sha256:${'a'.repeat(64)}`;
    const targetRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      targetPart,
      'target-record',
      '{"target":true}',
    );
    const targetCheckpoint = await checkpoint('claude', currentScope.sourceSessionId, targetPart, [
      targetRecord,
    ]);
    const stub = newLedger(currentScope);
    const result = await runInDurableObject(stub, (_instance, durableState) => {
      for (let index = 0; index < 256; index++) {
        const partId = `claude:part:sha256:${String(index).padStart(64, '0')}`;
        durableState.storage.sql.exec(
          'INSERT INTO ledger_scans (part_id, data) VALUES (?, ?) ',
          partId,
          JSON.stringify({
            checkpoint: { ...targetCheckpoint, source_transcript_part_id: partId },
          }),
        );
      }
      durableState.storage.sql.exec(
        'INSERT INTO ledger_scans (part_id, data) VALUES (?, ?)',
        targetPart,
        JSON.stringify({ checkpoint: targetCheckpoint }),
      );
      const queries: string[] = [];
      const sql = new Proxy(durableState.storage.sql, {
        get(target, property, receiver) {
          if (property === 'exec') {
            const exec = target.exec.bind(target);
            return (query: string, ...args: unknown[]) => {
              queries.push(query);
              if (
                query.toUpperCase().includes('FROM LEDGER_SCANS') &&
                (query.toUpperCase().includes('ORDER BY') || args[0] !== targetPart)
              ) {
                throw new Error('unbounded ledger_scans read');
              }
              return exec(query, ...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const storage: DurableObjectStorage = new Proxy(durableState.storage, {
        get(target, property, receiver) {
          if (property === 'sql') return sql;
          return Reflect.get(target, property, receiver);
        },
      });
      const snapshot = readLedgerSnapshot(storage);
      const scan = readLedgerScan(storage, targetPart);
      return { queries, snapshot, scan };
    });
    expect(result.snapshot).not.toHaveProperty('scans');
    expect(result.scan?.checkpoint).toEqual(targetCheckpoint);
    expect(
      result.queries.filter((query) => query.toUpperCase().includes('FROM LEDGER_SCANS')),
    ).toEqual(['SELECT data FROM ledger_scans WHERE part_id = ?']);
  });

  it('keeps retained-ledger reads fixed for retries and one-record appends', async () => {
    const currentScope = scope('codex', `fixed-ledger-reads-${crypto.randomUUID()}`);
    const records = await Promise.all(
      Array.from({ length: 2_048 }, (_, index) =>
        observation(
          'codex',
          currentScope.sourceSessionId,
          partFor('codex'),
          `codex:part:primary:codex:line:${index}`,
          JSON.stringify({ index }),
        ),
      ),
    );
    const initialPrefix = exactPrefix(records);
    const initialCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      records,
    );
    const initialUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: records,
      checkpoint: initialCheckpoint,
      complete_prefix_base64: base64(initialPrefix),
    } satisfies ArchiveUploadRequest;
    const stub = newLedger(currentScope);
    const initial = await call(stub, await envelope(currentScope, initialUpload));
    expect(initial.response.status).toBe(200);

    const commitWithReadSpy = async (value: Record<string, unknown>) =>
      runInDurableObject(stub, async (_instance, durableState) => {
        const retainedLedgerReads: string[] = [];
        const sql = new Proxy(durableState.storage.sql, {
          get(target, property, receiver) {
            if (property === 'exec') {
              const exec = target.exec.bind(target);
              return (query: string, ...args: unknown[]) => {
                if (query.toUpperCase().includes('FROM LEDGER_ELEMENTS')) {
                  retainedLedgerReads.push(query);
                }
                return exec(query, ...args);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
        const storage = new Proxy(durableState.storage, {
          get(target, property, receiver) {
            if (property === 'sql') return sql;
            if (property === 'transactionSync') return target.transactionSync.bind(target);
            return Reflect.get(target, property, receiver);
          },
        });
        const acknowledgement = await commitArchiveSession(
          storage,
          runtimeEnv as unknown as ArchiveApiEnv,
          value,
        );
        return { acknowledgement, retainedLedgerReads };
      });

    const exactRetry = await commitWithReadSpy(await envelope(currentScope, initialUpload));
    expect(exactRetry.acknowledgement).toEqual(initial.body);
    expect(exactRetry.retainedLedgerReads).toEqual([]);

    const appendRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      `codex:part:primary:codex:line:${records.length}`,
      JSON.stringify({ append: true }),
    );
    const appendedBytes = new TextEncoder().encode(`${appendRecord.payload}\n`);
    const completePrefix = new Uint8Array(initialPrefix.length + appendedBytes.length);
    completePrefix.set(initialPrefix);
    completePrefix.set(appendedBytes, initialPrefix.length);
    const appendCheckpoint = {
      ...initialCheckpoint,
      record_count: initialCheckpoint.record_count + 1,
      last_source_record_identity: appendRecord.source_record_identity,
      last_complete_byte_offset:
        initialCheckpoint.last_complete_byte_offset + appendedBytes.byteLength,
      observed_file_size: initialCheckpoint.observed_file_size + appendedBytes.byteLength,
      complete_prefix_sha256: await digest(completePrefix),
      prefix_chain_sha256: await prefixChainHash(
        initialCheckpoint.prefix_chain_sha256,
        appendedBytes,
      ),
    };
    const appendUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [appendRecord],
      checkpoint: appendCheckpoint,
      prior_checkpoint: initialCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: initialCheckpoint.prefix_chain_sha256,
        appended_prefix_base64: base64(appendedBytes),
      },
    } satisfies ArchiveUploadRequest;
    const appendResult = await commitWithReadSpy(await envelope(currentScope, appendUpload));
    expect(appendResult.acknowledgement.appended_records).toBe(1);
    expect(appendResult.retainedLedgerReads).toEqual([]);
  });

  it('keeps Claude checkpoint parts independent across multiple commits', async () => {
    const currentScope = scope('claude', `multi-part-${crypto.randomUUID()}`);
    const parentPart = 'claude:part:parent';
    const subagentPart = `claude:part:sha256:${'b'.repeat(64)}`;
    const parentRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      parentPart,
      'parent-record',
      '{"part":"parent"}',
    );
    const subagentRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      subagentPart,
      'subagent-record-1',
      '{"part":"subagent","index":1}',
    );
    const subagentAppend = await observation(
      'claude',
      currentScope.sourceSessionId,
      subagentPart,
      'subagent-record-2',
      '{"part":"subagent","index":2}',
    );
    const stub = newLedger(currentScope);
    const parentCheckpoint = await checkpoint('claude', currentScope.sourceSessionId, parentPart, [
      parentRecord,
    ]);
    const subagentCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      subagentPart,
      [subagentRecord],
    );
    const parentResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [parentRecord],
        checkpoint: parentCheckpoint,
        complete_prefix_base64: base64(exactPrefix([parentRecord])),
      }),
    );
    const subagentResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [subagentRecord],
        checkpoint: subagentCheckpoint,
        complete_prefix_base64: base64(exactPrefix([subagentRecord])),
      }),
    );
    expect(parentResult.response.status).toBe(200);
    expect(subagentResult.response.status).toBe(200);

    const subagentNextCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      subagentPart,
      [subagentRecord, subagentAppend],
    );
    const subagentAppendResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [subagentRecord, subagentAppend],
        checkpoint: subagentNextCheckpoint,
        prior_checkpoint: subagentCheckpoint,
        complete_prefix_base64: base64(exactPrefix([subagentRecord, subagentAppend])),
      }),
    );
    expect(subagentAppendResult.response.status).toBe(200);
    expect(subagentAppendResult.body).toMatchObject({
      appended_records: 1,
      record_count: 3,
    });

    const parentRescanCheckpoint = {
      ...parentCheckpoint,
      observed_file_size: parentCheckpoint.observed_file_size + 1,
    };
    const parentRescan = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [parentRecord],
        checkpoint: parentRescanCheckpoint,
        complete_prefix_base64: base64(exactPrefix([parentRecord])),
      }),
    );
    expect(parentRescan.response.status).toBe(200);
    expect(parentRescan.body).toMatchObject({ record_count: 3, appended_records: 0 });
  });

  it('matches the frozen Rust chain hash vectors', async () => {
    const raw = '{ "uuid": "r1", "value": 1 }';
    const record = await observation(
      'claude',
      'session-1',
      'claude:part:parent',
      'claude:part:parent:claude:id:r1:0',
      raw,
      10,
    );
    const recordHash = await recordChainHash(`sha256:${'00'.repeat(32)}`, 0, record);
    expect(recordHash).toBe(
      'sha256:01893501e31104a203f048c833ba70416de97b27c24f6b5bb5f25a2960061a9f',
    );
    const scanCheckpoint = await checkpoint(
      'claude',
      'session-1',
      'claude:part:parent',
      [record],
      undefined,
      10,
    );
    const checkpointHash = await checkpointChainHash(recordHash, 1, scanCheckpoint);
    expect(checkpointHash).toBe(
      'sha256:0e10b5049417b7d2bce25557c32e44cc9f3f321b99adc15e5782e78125e2ea11',
    );
  });

  it('deduplicates unchanged scans and retains changed same-identity versions', async () => {
    const currentScope = scope('claude', `versions-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"one"',
    );
    const firstCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const first = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    const unchanged = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(unchanged.body.duplicate).toBe(false);
    expect(unchanged.body.generation).toBe(first.body.generation);

    const changedRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"one-replaced"',
    );
    const changedCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord, changedRecord],
    );
    const changed = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord, changedRecord],
        checkpoint: changedCheckpoint,
        prior_checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord, changedRecord])),
      }),
    );
    expect(changed.response.status).toBe(200);
    expect(changed.body.appended_records).toBe(1);
    expect(changed.body.record_count).toBe(2);
    expect(changed.body.generation).toBe(2);
  });

  it('accepts a provable extension from a second collector without prior acknowledgement', async () => {
    const currentScope = scope('codex', `multi-collector-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      'r1',
      '"one"',
    );
    const secondRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      'r2',
      '"two"',
    );
    const firstCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const first = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(first.response.status).toBe(200);

    const unchangedDelta = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [],
        checkpoint: {
          ...firstCheckpoint,
          observed_file_size: firstCheckpoint.observed_file_size + 1,
        },
        prior_checkpoint: firstCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
          appended_prefix_base64: '',
        },
      }),
    );
    expect(unchangedDelta.response.status).toBe(200);
    expect(unchangedDelta.body.appended_records).toBe(0);
    expect(unchangedDelta.body.appended_checkpoint).toBe(false);

    const extensionCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord, secondRecord],
    );
    const extension = await call(
      newLedger(currentScope),
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord, secondRecord],
        checkpoint: extensionCheckpoint,
        complete_prefix_base64: base64(
          new TextEncoder().encode(`${firstRecord.payload}\n${secondRecord.payload}\n`),
        ),
      }),
    );
    expect(extension.response.status).toBe(200);
    expect(extension.body.appended_records).toBe(1);
    expect(extension.body.record_count).toBe(2);
    expect(extension.body.generation).toBe(2);
  });

  it('accepts an incremental batch with a bounded append proof', async () => {
    const currentScope = scope('claude', `incremental-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"one"',
    );
    const secondRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r2',
      '"two"',
    );
    const firstCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const first = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(first.response.status).toBe(200);

    const extensionCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord, secondRecord],
    );
    const appendedPrefix = new TextEncoder().encode('"two"\n');
    extensionCheckpoint.prefix_chain_sha256 = await prefixChainHash(
      firstCheckpoint.prefix_chain_sha256,
      appendedPrefix,
    );
    const extension = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [secondRecord],
        checkpoint: extensionCheckpoint,
        prior_checkpoint: firstCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
          appended_prefix_base64: base64(appendedPrefix),
        },
      }),
    );
    expect(extension.response.status).toBe(200);
    expect(extension.body.appended_records).toBe(1);
    expect(extension.body.record_count).toBe(2);
    expect(extension.body.generation).toBe(2);
  });

  it('rejects an incremental checkpoint without bounded append proof', async () => {
    const currentScope = scope('claude', `unproved-delta-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"one"',
    );
    const secondRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r2',
      '"two"',
    );
    const firstCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(initial.response.status).toBe(200);

    const rejected = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [secondRecord],
        checkpoint: await checkpoint('claude', currentScope.sourceSessionId, partFor('claude'), [
          firstRecord,
          secondRecord,
        ]),
        prior_checkpoint: firstCheckpoint,
      }),
    );
    expectIntegrity(rejected, 'checkpoint_prefix_unverifiable');
    const state = await runInDurableObject(
      stub,
      (_instance, durableState) =>
        [
          ...durableState.storage.sql.exec<{ data: string }>(
            'SELECT data FROM ledger_state WHERE id = 1',
          ),
        ][0]?.data,
    );
    if (!state) throw new Error('ledger state row missing');
    expect((JSON.parse(state) as { generation: number }).generation).toBe(1);
  });

  it('rejects changed or shortened history in a bounded append proof', async () => {
    const currentScope = scope('codex', `bounded-prefix-failure-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      'codex:part:primary:codex:line:0',
      '"first"',
    );
    const secondRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      'codex:part:primary:codex:line:1',
      '"second"',
    );
    const priorCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: priorCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(initial.response.status).toBe(200);

    const appendedPrefix = new TextEncoder().encode('"second"\n');
    const nextCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord, secondRecord],
    );
    nextCheckpoint.prefix_chain_sha256 = await prefixChainHash(
      priorCheckpoint.prefix_chain_sha256,
      appendedPrefix,
    );
    const changedHistory = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [secondRecord],
        checkpoint: nextCheckpoint,
        prior_checkpoint: priorCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: `sha256:${'11'.repeat(32)}`,
          appended_prefix_base64: base64(appendedPrefix),
        },
      }),
    );
    expectIntegrity(changedHistory, 'historical_prefix_changed');

    const shortenedHistory = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [secondRecord],
        checkpoint: {
          ...nextCheckpoint,
          last_complete_byte_offset: priorCheckpoint.last_complete_byte_offset - 1,
        },
        prior_checkpoint: priorCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: priorCheckpoint.prefix_chain_sha256,
          appended_prefix_base64: base64(appendedPrefix),
        },
      }),
    );
    expectIntegrity(shortenedHistory, 'historical_prefix_changed');
    const stateRows = await runInDurableObject(stub, (_instance, durableState) => [
      ...durableState.storage.sql.exec<{ data: string }>(
        'SELECT data FROM ledger_state WHERE id = 1',
      ),
    ]);
    expect(
      stateRows[0] ? (JSON.parse(stateRows[0].data) as { generation: number }).generation : 0,
    ).toBe(1);
  });

  it('accepts a bounded append proof from a transcript larger than the HTTP cap', async () => {
    const currentScope = scope('codex', `long-history-${crypto.randomUUID()}`);
    const stub = newLedger(currentScope);
    const batchSize = 100;
    const totalRecords = 2_500;
    const payloads = Array.from({ length: totalRecords }, (_, index) =>
      JSON.stringify({ index, value: 'x'.repeat(3_400) }),
    );
    let historicalPrefix = new Uint8Array();
    let priorCheckpoint: CompletedScanCheckpoint | undefined;
    for (let start = 0; start < payloads.length; start += batchSize) {
      const batchPayloads = payloads.slice(start, start + batchSize);
      const records = await Promise.all(
        batchPayloads.map((payload, index) =>
          observation(
            currentScope.source,
            currentScope.sourceSessionId,
            partFor(currentScope.source),
            `codex:part:primary:codex:line:${start + index}`,
            payload,
          ),
        ),
      );
      const deltaBytes = new TextEncoder().encode(
        batchPayloads.map((payload) => `${payload}\n`).join(''),
      );
      const nextPrefix = new Uint8Array(historicalPrefix.length + deltaBytes.length);
      nextPrefix.set(historicalPrefix);
      nextPrefix.set(deltaBytes, historicalPrefix.length);
      const batchCheckpoint = await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        records,
      );
      const nextCheckpoint = priorCheckpoint
        ? {
            ...batchCheckpoint,
            record_count: start + records.length,
            last_source_record_identity: records.at(-1)!.source_record_identity,
            last_complete_byte_offset: nextPrefix.byteLength,
            observed_file_size: nextPrefix.byteLength,
            complete_prefix_sha256: await digest(nextPrefix),
            prefix_chain_sha256: await prefixChainHash(
              priorCheckpoint.prefix_chain_sha256,
              deltaBytes,
            ),
            first_observed_at: priorCheckpoint.first_observed_at,
          }
        : batchCheckpoint;
      const upload = {
        source_session_id: currentScope.sourceSessionId,
        observations: records,
        checkpoint: nextCheckpoint,
        ...(priorCheckpoint
          ? {
              prior_checkpoint: priorCheckpoint,
              append_proof: {
                prior_prefix_chain_sha256: priorCheckpoint.prefix_chain_sha256,
                appended_prefix_base64: base64(deltaBytes),
              },
            }
          : { complete_prefix_base64: base64(exactPrefix(records)) }),
      } satisfies ArchiveUploadRequest;
      const result = await call(stub, await envelope(currentScope, upload));
      expect(result.response.status).toBe(200);
      historicalPrefix = nextPrefix;
      priorCheckpoint = nextCheckpoint;
    }
    expect(historicalPrefix.byteLength).toBeGreaterThan(MAX_ARCHIVE_UPLOAD_BYTES);

    const appendRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      `codex:part:primary:codex:line:${totalRecords}`,
      '{"append":true}',
    );
    const appendBytes = new TextEncoder().encode(`${appendRecord.payload}\n`);
    const appendPrefix = new Uint8Array(historicalPrefix.length + appendBytes.length);
    appendPrefix.set(historicalPrefix);
    appendPrefix.set(appendBytes, historicalPrefix.length);
    const appendCheckpoint = {
      ...priorCheckpoint!,
      record_count: totalRecords + 1,
      last_source_record_identity: appendRecord.source_record_identity,
      last_complete_byte_offset: priorCheckpoint!.last_complete_byte_offset + appendBytes.length,
      observed_file_size: priorCheckpoint!.observed_file_size + appendBytes.length,
      complete_prefix_sha256: await digest(appendPrefix),
      prefix_chain_sha256: await prefixChainHash(priorCheckpoint!.prefix_chain_sha256, appendBytes),
    };
    const appendUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [appendRecord],
      checkpoint: appendCheckpoint,
      prior_checkpoint: priorCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: priorCheckpoint!.prefix_chain_sha256,
        appended_prefix_base64: base64(appendBytes),
      },
    } satisfies ArchiveUploadRequest;
    expect(new TextEncoder().encode(JSON.stringify(appendUpload)).byteLength).toBeLessThan(
      MAX_ARCHIVE_UPLOAD_BYTES,
    );
    const collectorSecret = 'long-history-handler-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'long-history-handler-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const handlerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'long-history-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'long-history-handler-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      const keyResponse = await fallbackArchiveKeyHttp(url.pathname, currentScope.orgId);
      if (keyResponse) return keyResponse;
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const handlerEnv = {
      ...runtimeEnv,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
    } as unknown as ArchiveApiEnv;
    let appendResult: { response: Response; body: Record<string, unknown> };
    try {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': collectorSecret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(appendUpload),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      appendResult = { response, body: await response.json<Record<string, unknown>>() };
    } finally {
      handlerFetch.mockRestore();
    }
    expect(appendResult.response.status).toBe(200);
    expect(appendResult.body.record_count).toBe(totalRecords + 1);

    const rootObject = await runtimeEnv.ARCHIVE_STORAGE.get(
      appendResult.body.manifest_key as string,
    );
    if (!rootObject) throw new Error('paged manifest root missing');
    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const root = JSON.parse(
      new TextDecoder().decode(
        await decryptArchiveObject(JSON.parse(await rootObject.text()), {
          key,
          orgId: currentScope.orgId,
          objectKey: appendResult.body.manifest_key as string,
          objectClass: 'manifest',
          keyVersion: KEY_VERSION,
        }),
      ),
    ) as { pages: { page_key: string; element_count: number }[]; element_count: number };
    expect(root.element_count).toBe(totalRecords + Math.ceil(totalRecords / batchSize) + 2);
    expect(root.pages).toHaveLength(1);
    let pageElementCount = 0;
    const visited = new Set<string>();
    const visitPage = async (pageKey: string): Promise<void> => {
      if (visited.has(pageKey)) return;
      visited.add(pageKey);
      const pageObject = await runtimeEnv.ARCHIVE_STORAGE.get(pageKey);
      if (!pageObject) throw new Error('paged manifest page missing');
      const page = JSON.parse(
        new TextDecoder().decode(
          await decryptArchiveObject(JSON.parse(await pageObject.text()), {
            key,
            orgId: currentScope.orgId,
            objectKey: pageKey,
            objectClass: 'manifest',
            keyVersion: KEY_VERSION,
          }),
        ),
      ) as {
        elements?: { byte_range: { start: number; end: number } }[];
        pages?: { page_key: string }[];
        previous_page_key?: string;
        element_count: number;
      };
      if (page.elements) {
        expect(
          page.elements.every((element) => element.byte_range.end > element.byte_range.start),
        ).toBe(true);
        pageElementCount += page.element_count;
      } else {
        for (const reference of page.pages ?? []) await visitPage(reference.page_key);
        if (page.previous_page_key) await visitPage(page.previous_page_key);
      }
    };
    await visitPage(root.pages[0]!.page_key);
    expect(pageElementCount).toBe(root.element_count);

    const archiveObjects: { key: string; size: number }[] = [];
    let inventoryCursor: string | undefined;
    do {
      const page = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
        ...(inventoryCursor === undefined ? {} : { cursor: inventoryCursor }),
      });
      archiveObjects.push(...page.objects.map(({ key, size }) => ({ key, size })));
      inventoryCursor = page.truncated ? page.cursor : undefined;
    } while (inventoryCursor !== undefined);
    const budgetSnapshot = await runtimeEnv.STORAGE_BUDGET.getByName(
      currentScope.orgId,
    ).getStorageBudget({
      orgId: currentScope.orgId,
    });
    expect(budgetSnapshot.committedBytes).toBe(
      archiveObjects.reduce((sum, archiveObject) => sum + archiveObject.size, 0),
    );
    expect(budgetSnapshot.byClass.agent_archive_chunk.committedBytes).toBe(
      archiveObjects
        .filter(({ key }) => key.includes('/chunks/'))
        .reduce((sum, archiveObject) => sum + archiveObject.size, 0),
    );
    expect(budgetSnapshot.byClass.agent_archive_manifest.committedBytes).toBe(
      archiveObjects
        .filter(({ key }) => key.includes('/manifests/'))
        .reduce((sum, archiveObject) => sum + archiveObject.size, 0),
    );
  }, 60_000);
});
