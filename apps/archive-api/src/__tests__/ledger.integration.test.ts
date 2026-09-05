import { beforeEach, describe, expect, it } from 'vitest';
import {
  runInDurableObject,
  decryptArchiveObject,
  unwrapArchiveEncryptionKey,
  ARCHIVE_FORMAT_VERSION,
  CHAIN_HASH_VERSION,
  GENESIS_CHAIN_HASH,
  MAX_UPLOAD_OBSERVATIONS,
  archiveSessionPrefix,
  prefixChainHash,
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
  scope,
  envelope,
  call,
  newLedger,
  seedPendingCommit,
  expectIntegrity,
} from './ledger.integration.fixtures';
import type {
  ArchiveScope,
  ArchiveUploadRequest,
  CompletedScanCheckpoint,
  StoredElement,
} from './ledger.integration.fixtures';
import { assertPlannedChain, buildRecord, checkpointChainHash } from '../archive-chain';

describe('Archive Session Ledger', () => {
  beforeEach(() => {
    expect(runtimeEnv.ARCHIVE_KEY_WRAPPING_SECRET).toBe(WRAPPING_SECRET);
  });

  it('rejects tampered record links and checkpoint hashes in a planned append', async () => {
    const currentScope = scope('claude', `chain-verification-${crypto.randomUUID()}`);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'chain-record',
      '{"chain":true}',
    );
    const storedRecord = await buildRecord(record, 0, GENESIS_CHAIN_HASH);
    const completedCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [record],
    );
    const storedCheckpoint: StoredElement = {
      kind: 'checkpoint',
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      chain_hash_version: CHAIN_HASH_VERSION,
      source: currentScope.source,
      source_session_id: currentScope.sourceSessionId,
      source_transcript_part_id: partFor(currentScope.source),
      checkpoint: completedCheckpoint,
      chain_sequence: 1,
      previous_chain_hash: storedRecord.chain_hash,
      chain_hash: await checkpointChainHash(storedRecord.chain_hash, 1, completedCheckpoint),
    };
    const elements = [storedRecord, storedCheckpoint];
    await expect(assertPlannedChain(GENESIS_CHAIN_HASH, 0, elements)).resolves.toBeUndefined();
    await expect(
      assertPlannedChain(GENESIS_CHAIN_HASH, 0, [
        { ...storedRecord, previous_chain_hash: `sha256:${'11'.repeat(32)}` },
        storedCheckpoint,
      ]),
    ).rejects.toMatchObject({ errorClass: 'chain_link_verification_failed' });
    await expect(
      assertPlannedChain(GENESIS_CHAIN_HASH, 0, [
        storedRecord,
        { ...storedCheckpoint, chain_hash: `sha256:${'22'.repeat(32)}` },
      ]),
    ).rejects.toMatchObject({ errorClass: 'chain_link_verification_failed' });
    const objects = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(objects.objects).toHaveLength(0);
  });

  it('latches an authenticated pending intent with a broken chain link before acknowledgement', async () => {
    const currentScope = scope('codex', `pending-chain-${crypto.randomUUID()}`);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'pending-chain-record',
      '{"chain":"tampered"}',
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    } satisfies ArchiveUploadRequest;
    const { stub } = await seedPendingCommit(currentScope, upload, (commit) => {
      const first = commit.newElements[0];
      if (!first) throw new Error('pending record missing');
      commit.newElements[0] = {
        ...first,
        previous_chain_hash: `sha256:${'33'.repeat(32)}`,
      };
    });

    const rejected = await call(stub, await envelope(currentScope, upload));
    expectIntegrity(rejected, 'chain_link_verification_failed');
    const canonical = await runInDurableObject(stub, (_instance, state) => ({
      ledger: [...state.storage.sql.exec('SELECT data FROM ledger_state')],
      elements: [...state.storage.sql.exec('SELECT data FROM ledger_elements')],
    }));
    expect(canonical).toEqual({ ledger: [], elements: [] });
  });

  it.each(['claude', 'codex'] as const)(
    'serializes concurrent first use and lost-response retry for %s',
    async (source) => {
      const currentScope = scope(source, `first-use-${crypto.randomUUID()}`);
      const record = await observation(
        source,
        currentScope.sourceSessionId,
        partFor(source),
        'r1',
        '"first"',
      );
      const upload = {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: await checkpoint(source, currentScope.sourceSessionId, partFor(source), [
          record,
        ]),
        complete_prefix_base64: base64(exactPrefix([record])),
      };
      const firstStub = newLedger(currentScope);
      const secondStub = newLedger(currentScope);
      const [first, second] = await Promise.all([
        call(firstStub, await envelope(currentScope, upload)),
        call(secondStub, await envelope(currentScope, upload)),
      ]);
      expect(first.response.status).toBe(200);
      expect(second.response.status).toBe(200);
      expect(first.body.manifest_key).toBe(second.body.manifest_key);
      expect(first.body.generation).toBe(1);

      const retry = await call(firstStub, await envelope(currentScope, upload));
      expect(retry.response.status).toBe(200);
      expect(retry.body.duplicate).toBe(false);
      expect(retry.body.manifest_key).toBe(first.body.manifest_key);
      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(listed.objects).toHaveLength(2);
      expect(await archiveSessionPrefix(currentScope)).toContain('/contributions/');
      expect(await archiveSessionPrefix(currentScope)).not.toContain(currentScope.contributionId);
      const intentState = await runInDurableObject(firstStub, (_instance, state) => ({
        pendingParts: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_intent_parts',
          ),
        ][0]?.count,
        status: [
          ...state.storage.sql.exec<{ status: string }>(
            'SELECT status FROM pending_intents LIMIT 1',
          ),
        ][0]?.status,
      }));
      expect(intentState.pendingParts).toBe(0);
      expect(intentState.status).toBe('committed');
    },
  );

  it('uses a partial index for active intent recovery after many committed generations', async () => {
    const currentScope = scope('codex', `active-intent-index-${crypto.randomUUID()}`);
    const stub = newLedger(currentScope);
    const result = await runInDurableObject(stub, (_instance, durableState) => {
      for (let index = 0; index < 2048; index++) {
        durableState.storage.sql.exec(
          'INSERT INTO pending_intents (intent_hash, status, base_element_count, base_chain_head) VALUES (?, ?, ?, ?)',
          `committed-intent-${index}`,
          'committed',
          index,
          GENESIS_CHAIN_HASH,
        );
      }
      const explain = () => [
        ...durableState.storage.sql.exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT intent_hash FROM pending_intents WHERE status IN ('building', 'ready', 'write_authorized') LIMIT 1",
        ),
      ];
      const planBefore = explain();
      durableState.storage.sql.exec(
        'INSERT INTO pending_intents (intent_hash, status, base_element_count, base_chain_head) VALUES (?, ?, ?, ?)',
        'active-intent',
        'building',
        2048,
        GENESIS_CHAIN_HASH,
      );
      return {
        committedCount: [
          ...durableState.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM pending_intents WHERE status = 'committed'",
          ),
        ][0]?.count,
        planBefore,
        planAfter: explain(),
        pendingIntentHash: [
          ...durableState.storage.sql.exec<{ intent_hash: string }>(
            "SELECT intent_hash FROM pending_intents WHERE status = 'building' LIMIT 1",
          ),
        ][0]?.intent_hash,
      };
    });
    const assertIndexed = (plan: { detail: string }[]) => {
      expect(plan.some((row) => row.detail.includes('pending_intents_active_status'))).toBe(true);
      expect(plan.some((row) => /SCAN pending_intents(?! USING INDEX)/.test(row.detail))).toBe(
        false,
      );
    };
    expect(result.committedCount).toBe(2048);
    assertIndexed(result.planBefore);
    assertIndexed(result.planAfter);
    expect(result.pendingIntentHash).toBe('active-intent');
  });

  it('bounds near-cap request counts before hashing and rejects over-cap requests', async () => {
    const nearScope = scope('codex', `incoming-count-near-${crypto.randomUUID()}`);
    const nearCap = await call(
      newLedger(nearScope),
      await envelope(nearScope, {
        source_session_id: nearScope.sourceSessionId,
        observations: new Array(MAX_UPLOAD_OBSERVATIONS).fill(null),
        checkpoint: null,
      } as unknown as ArchiveUploadRequest),
    );
    expect(nearCap.response.status).toBe(400);
    expect(nearCap.body.error).toBe('invalid_observation');

    const overScope = scope('codex', `incoming-count-over-${crypto.randomUUID()}`);
    const rejected = await call(
      newLedger(overScope),
      await envelope(overScope, {
        source_session_id: overScope.sourceSessionId,
        observations: new Array(MAX_UPLOAD_OBSERVATIONS + 1).fill(null),
        checkpoint: null,
      } as unknown as ArchiveUploadRequest),
    );
    expect(rejected.response.status).toBe(413);
    expect(rejected.body.error).toBe('archive_upload_observation_limit');
    const stateRows = await runInDurableObject(newLedger(overScope), (_instance, state) => [
      ...state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_state'),
    ]);
    expect(stateRows[0]?.count).toBe(0);
    const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(overScope),
    });
    expect(stored.objects).toHaveLength(0);
  });

  it('commits the exact per-request observation boundary and appends afterward', async () => {
    const currentScope: ArchiveScope = {
      orgId: 'org-exact-max',
      userId: 'user-exact-max',
      contributionId: 'contribution-exact-max',
      source: 'codex',
      sourceSessionId: 'session-exact-max',
    };
    const part = partFor(currentScope.source);
    const payload = '{}';
    const contentSha256 = await digest(new TextEncoder().encode(payload));
    const observations: Awaited<ReturnType<typeof observation>>[] = Array.from(
      { length: MAX_UPLOAD_OBSERVATIONS },
      (_, index) => ({
        archive_format_version: ARCHIVE_FORMAT_VERSION,
        chain_hash_version: CHAIN_HASH_VERSION,
        source: currentScope.source,
        source_session_id: currentScope.sourceSessionId,
        source_transcript_part_id: part,
        source_record_identity: `${part}:codex:line:${index}`,
        observed_at: 1_700_000_000_000,
        payload_encoding: 'utf8' as const,
        payload,
        content_sha256: contentSha256,
      }),
    );
    const upload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations,
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        part,
        observations,
      ),
      complete_prefix_base64: base64(
        new TextEncoder().encode(payload.concat('\n').repeat(MAX_UPLOAD_OBSERVATIONS)),
      ),
    };
    const stub = newLedger(currentScope);
    const rejected = await call(stub, await envelope(currentScope, upload));
    expect(rejected.response.status).toBe(200);
    expect(rejected.body.record_count).toBe(MAX_UPLOAD_OBSERVATIONS);

    const stateCounts = await runInDurableObject(stub, (_instance, state) => ({
      ledgerState: [
        ...state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_state'),
      ][0]?.count,
      ledgerElements: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_elements',
        ),
      ][0]?.count,
      pendingIntents: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM pending_intents',
        ),
      ][0]?.count,
    }));
    expect(stateCounts.ledgerState).toBe(1);
    expect(stateCounts.ledgerElements).toBe(MAX_UPLOAD_OBSERVATIONS + 1);
    expect(stateCounts.pendingIntents).toBe(1);
    const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(stored.objects.length).toBeGreaterThan(2);

    const appended = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      'codex:part:primary:codex:line:after-max',
      '"after-max"',
    );
    const appendedPrefix = new TextEncoder().encode('"after-max"\n');
    const appendedCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      [appended],
    );
    const prior = upload.checkpoint;
    const deltaCheckpoint = {
      ...appendedCheckpoint,
      record_count: MAX_UPLOAD_OBSERVATIONS + 1,
      last_source_record_identity: appended.source_record_identity,
      last_complete_byte_offset: prior.last_complete_byte_offset + appendedPrefix.byteLength,
      observed_file_size: prior.observed_file_size + appendedPrefix.byteLength,
      first_observed_at: prior.first_observed_at,
      complete_prefix_sha256: await digest(
        new TextEncoder().encode(
          `${payload.concat('\n').repeat(MAX_UPLOAD_OBSERVATIONS)}"after-max"\n`,
        ),
      ),
      prefix_chain_sha256: await prefixChainHash(prior.prefix_chain_sha256, appendedPrefix),
    };
    const appendResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [appended],
        checkpoint: deltaCheckpoint,
        prior_checkpoint: prior,
        append_proof: {
          prior_prefix_chain_sha256: prior.prefix_chain_sha256,
          appended_prefix_base64: base64(appendedPrefix),
        },
      }),
    );
    expect(appendResult.response.status).toBe(200);
    expect(appendResult.body.record_count).toBe(MAX_UPLOAD_OBSERVATIONS + 1);
  }, 30_000);

  it('keeps manifest and intent work bounded across more than 16,384 records', async () => {
    const currentScope = scope('codex', `paged-lifetime-${crypto.randomUUID()}`);
    const stub = newLedger(currentScope);
    const part = partFor(currentScope.source);
    const firstPayload = '{}';
    const firstHash = await digest(new TextEncoder().encode(firstPayload));
    const firstRecords: ArchiveUploadRequest['observations'] = Array.from(
      { length: MAX_UPLOAD_OBSERVATIONS },
      (_, index) => ({
        archive_format_version: ARCHIVE_FORMAT_VERSION,
        chain_hash_version: CHAIN_HASH_VERSION,
        source: currentScope.source,
        source_session_id: currentScope.sourceSessionId,
        source_transcript_part_id: part,
        source_record_identity: `${part}:codex:line:${index}`,
        observed_at: 1_700_000_000_000,
        payload_encoding: 'utf8' as const,
        payload: firstPayload,
        content_sha256: firstHash,
      }),
    );
    const firstBytes = new TextEncoder().encode(
      firstPayload.concat('\n').repeat(firstRecords.length),
    );
    let historicalPrefix = firstBytes;
    let priorCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      firstRecords,
    );
    const firstResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: firstRecords,
        checkpoint: priorCheckpoint,
        complete_prefix_base64: base64(firstBytes),
      }),
    );
    expect(firstResult.response.status).toBe(200);

    const appendBatchSize = 4096;
    for (let batch = 0; batch < 4; batch++) {
      const payload = JSON.stringify({ batch, value: 'append' });
      const contentSha256 = await digest(new TextEncoder().encode(payload));
      const records: ArchiveUploadRequest['observations'] = Array.from(
        { length: appendBatchSize },
        (_, index) => ({
          archive_format_version: ARCHIVE_FORMAT_VERSION,
          chain_hash_version: CHAIN_HASH_VERSION,
          source: currentScope.source,
          source_session_id: currentScope.sourceSessionId,
          source_transcript_part_id: part,
          source_record_identity: `${part}:codex:line:${MAX_UPLOAD_OBSERVATIONS + batch * appendBatchSize + index}`,
          observed_at: 1_700_000_000_001 + batch,
          payload_encoding: 'utf8' as const,
          payload,
          content_sha256: contentSha256,
        }),
      );
      const appendedBytes = new TextEncoder().encode(
        records.map((record) => `${record.payload}\n`).join(''),
      );
      const nextPrefix = new Uint8Array(historicalPrefix.byteLength + appendedBytes.byteLength);
      nextPrefix.set(historicalPrefix);
      nextPrefix.set(appendedBytes, historicalPrefix.byteLength);
      const batchCheckpoint = await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        part,
        records,
      );
      const nextCheckpoint: CompletedScanCheckpoint = {
        ...batchCheckpoint,
        record_count: priorCheckpoint.record_count + records.length,
        last_source_record_identity: records.at(-1)!.source_record_identity,
        last_complete_byte_offset: nextPrefix.byteLength,
        observed_file_size: nextPrefix.byteLength,
        complete_prefix_sha256: await digest(nextPrefix),
        prefix_chain_sha256: await prefixChainHash(
          priorCheckpoint.prefix_chain_sha256,
          appendedBytes,
        ),
        first_observed_at: priorCheckpoint.first_observed_at,
      };
      const result = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: records,
          checkpoint: nextCheckpoint,
          prior_checkpoint: priorCheckpoint,
          append_proof: {
            prior_prefix_chain_sha256: priorCheckpoint.prefix_chain_sha256,
            appended_prefix_base64: base64(appendedBytes),
          },
        }),
      );
      expect(result.response.status).toBe(200);
      expect(result.body.record_count).toBe(
        MAX_UPLOAD_OBSERVATIONS + (batch + 1) * appendBatchSize,
      );
      const intentBounds = await runInDurableObject(stub, (_instance, state) => ({
        pendingParts: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_intent_parts',
          ),
        ][0]?.count,
        committedMetadataBytes: [
          ...state.storage.sql.exec<{ bytes: number }>(
            'SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM pending_intent_metadata',
          ),
        ][0]?.bytes,
      }));
      expect(intentBounds.pendingParts).toBe(0);
      expect(intentBounds.committedMetadataBytes).toBeLessThan(16 * 1024);
      historicalPrefix = nextPrefix;
      priorCheckpoint = nextCheckpoint;
    }

    const rootKey = (
      await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [],
          checkpoint: {
            ...priorCheckpoint,
            observed_file_size: priorCheckpoint.observed_file_size + 1,
          },
          prior_checkpoint: priorCheckpoint,
          append_proof: {
            prior_prefix_chain_sha256: priorCheckpoint.prefix_chain_sha256,
            appended_prefix_base64: '',
          },
        }),
      )
    ).body.manifest_key as string;
    const manifestObject = await runtimeEnv.ARCHIVE_STORAGE.get(rootKey);
    if (!manifestObject) throw new Error('lifetime manifest root missing');
    const key = await unwrapArchiveEncryptionKey(JSON.parse(await archiveKey(currentScope.orgId)), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const decodeManifest = async (keyName: string) => {
      const object = await runtimeEnv.ARCHIVE_STORAGE.get(keyName);
      if (!object) throw new Error('lifetime manifest page missing');
      return JSON.parse(
        new TextDecoder().decode(
          await decryptArchiveObject(JSON.parse(await object.text()), {
            key,
            orgId: currentScope.orgId,
            objectKey: keyName,
            objectClass: 'manifest',
            keyVersion: KEY_VERSION,
          }),
        ),
      ) as {
        elements?: { chain_sequence: number; byte_range: { start: number; end: number } }[];
        pages?: { page_key: string; element_count: number }[];
        previous_page_key?: string;
        element_count: number;
      };
    };
    const root = (await decodeManifest(rootKey)) as {
      pages: { page_key: string; element_count: number }[];
      element_count: number;
    };
    expect(root.pages).toHaveLength(1);
    const seen = new Set<string>();
    const sequences = new Set<number>();
    const visit = async (keyName: string): Promise<void> => {
      if (seen.has(keyName)) return;
      seen.add(keyName);
      const page = await decodeManifest(keyName);
      if (page.elements) {
        for (const element of page.elements) {
          expect(element.byte_range.end).toBeGreaterThan(element.byte_range.start);
          sequences.add(element.chain_sequence);
        }
        return;
      }
      expect(page.pages?.length ?? 0).toBeLessThanOrEqual(128);
      for (const reference of page.pages ?? []) await visit(reference.page_key);
      if (page.previous_page_key) await visit(page.previous_page_key);
    };
    await visit(root.pages[0]!.page_key);
    expect(sequences.size).toBe(MAX_UPLOAD_OBSERVATIONS + 1 + 4 * (appendBatchSize + 1));
    expect(root.element_count).toBe(sequences.size);
    expect(seen.size).toBe(
      Math.ceil((MAX_UPLOAD_OBSERVATIONS + 1) / 256) +
        1 +
        4 * (Math.ceil((appendBatchSize + 1) / 256) + 1),
    );
  }, 30_000);
});
