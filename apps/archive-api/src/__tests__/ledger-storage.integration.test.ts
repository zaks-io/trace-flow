import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
  decryptArchiveObject,
  sha256Hex,
  unwrapArchiveEncryptionKey,
  MAX_CHUNK_BYTES,
  canonicalElement,
  archiveSessionPrefix,
  packNewElements,
  decompress,
  commitArchiveSession,
  ARCHIVE_STORAGE_CAP_BYTES,
  readPendingIntent,
  agentIngestApp,
  __resetPolicyCache,
  agentIngestEnvelope,
  WRAPPING_SECRET,
  KEY_VERSION,
  runtimeEnv,
  partFor,
  base64,
  exactPrefix,
  observation,
  checkpoint,
  archiveKey,
  scope,
  envelope,
  call,
  newLedger,
  seedPendingCommit,
  readLedgerSnapshot,
  expectIntegrity,
  expectAgentFactSyncAccepted,
} from './ledger.integration.fixtures';
import type {
  ArchiveScope,
  ArchiveUploadRequest,
  StoredRecord,
  ArchiveApiEnv,
  AgentIngestEnv,
} from './ledger.integration.fixtures';

describe('Archive Session Ledger', () => {
  beforeEach(() => {
    expect(runtimeEnv.ARCHIVE_KEY_WRAPPING_SECRET).toBe(WRAPPING_SECRET);
  });

  it('writes encrypted lossless chunks and manifests with exact byte ranges', async () => {
    const currentScope = scope('claude', `manifest-${crypto.randomUUID()}`);
    const first = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '{"marker":"PLAINTEXT_MARKER"}',
    );
    const firstCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [first],
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [first],
      checkpoint: firstCheckpoint,
      complete_prefix_base64: base64(exactPrefix([first])),
    };
    const stub = newLedger(currentScope);
    const result = await call(stub, await envelope(currentScope, upload));
    expect(result.response.status).toBe(200);
    const ledgerRows = await runInDurableObject(stub, (_instance, state) => ({
      metadata: [
        ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
      ][0]?.data,
      elements: [
        ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_elements'),
      ].map((row) => row.data),
    }));
    expect(JSON.stringify(ledgerRows)).not.toContain('PLAINTEXT_MARKER');
    const manifestObject = await runtimeEnv.ARCHIVE_STORAGE.get(result.body.manifest_key as string);
    expect(manifestObject).not.toBeNull();
    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const manifestBytes = await decryptArchiveObject(JSON.parse(await manifestObject!.text()), {
      key,
      orgId: currentScope.orgId,
      objectKey: result.body.manifest_key as string,
      objectClass: 'manifest',
      keyVersion: KEY_VERSION,
    });
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      elements: { byte_range: { chunk_id: string; start: number; end: number } }[];
    };
    expect(manifest.elements).toHaveLength(2);
    const chunkKey = result.body.chunk_keys as string[];
    const chunkObject = await runtimeEnv.ARCHIVE_STORAGE.get(chunkKey[0]!);
    const compressed = await decryptArchiveObject(JSON.parse(await chunkObject!.text()), {
      key,
      orgId: currentScope.orgId,
      objectKey: chunkKey[0]!,
      objectClass: 'chunk',
      keyVersion: KEY_VERSION,
    });
    const plain = await decompress(compressed);
    for (const element of manifest.elements) {
      expect(element.byte_range.chunk_id).toBe(chunkKey[0]!.split('/').at(-1));
      expect(element.byte_range.end).toBeGreaterThan(element.byte_range.start);
      expect(element.byte_range.end).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(plain.slice(element.byte_range.start, element.byte_range.end).byteLength).toBe(
        element.byte_range.end - element.byte_range.start,
      );
    }
    const rawChunk = await runtimeEnv.ARCHIVE_STORAGE.get(chunkKey[0]!);
    const rawManifest = await runtimeEnv.ARCHIVE_STORAGE.get(result.body.manifest_key as string);
    expect(await rawChunk!.text()).not.toContain('PLAINTEXT_MARKER');
    expect(await rawManifest!.text()).not.toContain('PLAINTEXT_MARKER');
  });

  it('latches a committed R2 corruption before the next canonical commit', async () => {
    const currentScope = scope('codex', `committed-corruption-${crypto.randomUUID()}`);
    const first = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      '0',
      '{"value":"first"}',
    );
    const initialUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [first],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [first],
      ),
      complete_prefix_base64: base64(exactPrefix([first])),
    };
    const initial = await call(
      newLedger(currentScope),
      await envelope(currentScope, initialUpload),
    );
    expect(initial.response.status).toBe(200);
    const priorState = await runInDurableObject(newLedger(currentScope), (_instance, state) =>
      readLedgerSnapshot(state.storage),
    );
    const manifestKey = initial.body.manifest_key as string;
    const corruptBody = '{"corrupt":"committed-manifest"}';
    await runtimeEnv.ARCHIVE_STORAGE.put(manifestKey, corruptBody);
    const objectsBeforeAppend = (
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) })
    ).objects.map(({ key, size }) => ({ key, size }));

    const second = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      '1',
      '{"value":"second"}',
    );
    const nextUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [first, second],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [first, second],
      ),
      complete_prefix_base64: base64(exactPrefix([first, second])),
    };
    const rejected = await call(newLedger(currentScope), await envelope(currentScope, nextUpload));
    expectIntegrity(rejected, 'r2_object_verification_failed');
    expect(rejected.body.newly_recorded).toBe(true);
    const stateAfterRejection = await runInDurableObject(
      newLedger(currentScope),
      (_instance, state) => readLedgerSnapshot(state.storage),
    );
    expect(stateAfterRejection).toEqual(priorState);
    const corruptObject = await runtimeEnv.ARCHIVE_STORAGE.get(manifestKey);
    expect(await corruptObject!.text()).toBe(corruptBody);
    const objectsAfterRejection = (
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) })
    ).objects.map(({ key, size }) => ({ key, size }));
    expect(objectsAfterRejection).toEqual(objectsBeforeAppend);

    const retry = await call(newLedger(currentScope), await envelope(currentScope, nextUpload));
    expectIntegrity(retry, 'r2_object_verification_failed');
    expect(retry.body.operation_id).toBe(rejected.body.operation_id);
    expect(retry.body.newly_recorded).toBe(false);
    const objectsAfterRetry = (
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) })
    ).objects.map(({ key, size }) => ({ key, size }));
    expect(objectsAfterRetry).toEqual(objectsBeforeAppend);

    const healthyScope = {
      ...currentScope,
      sourceSessionId: `committed-corruption-healthy-${crypto.randomUUID()}`,
    };
    const healthyRecord = await observation(
      healthyScope.source,
      healthyScope.sourceSessionId,
      partFor(healthyScope.source),
      'healthy-0',
      '{"value":"healthy"}',
    );
    const healthy = await call(
      newLedger(healthyScope),
      await envelope(healthyScope, {
        source_session_id: healthyScope.sourceSessionId,
        observations: [healthyRecord],
        checkpoint: await checkpoint(
          healthyScope.source,
          healthyScope.sourceSessionId,
          partFor(healthyScope.source),
          [healthyRecord],
        ),
        complete_prefix_base64: base64(exactPrefix([healthyRecord])),
      }),
    );
    expect(healthy.response.status).toBe(200);
    await expectAgentFactSyncAccepted(currentScope, 'committed-corruption-fact-secret');
  });

  it('leaves a colliding manifest noncanonical and rejects stable retries', async () => {
    const currentScope = scope('codex', `verify-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '{"value":"verify"}',
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const { stub } = await seedPendingCommit(currentScope, upload);
    const manifestObject = await runInDurableObject(stub, (_instance, state) => {
      const pending = readPendingIntent(state.storage);
      return pending?.objects.find(({ objectClass }) => objectClass === 'manifest');
    });
    if (!manifestObject) throw new Error('pending manifest missing');
    const manifestKey = manifestObject.key;
    await runtimeEnv.ARCHIVE_STORAGE.put(
      manifestKey,
      'x'.repeat(new TextEncoder().encode(manifestObject.body).byteLength),
    );

    const rejected = await call(stub, await envelope(currentScope, upload));
    expectIntegrity(rejected, 'immutable_object_collision');
    expect(rejected.body.newly_recorded).toBe(true);
    const canonicalState = await runInDurableObject(stub, (_instance, state) => ({
      ledger: [...state.storage.sql.exec('SELECT data FROM ledger_state')],
      elements: [...state.storage.sql.exec('SELECT data FROM ledger_elements')],
    }));
    expect(canonicalState).toEqual({ ledger: [], elements: [] });
    const beforeRetry = (
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) })
    ).objects.map(({ key, size }) => ({ key, size }));
    expect(beforeRetry.map(({ key }) => key)).toContain(manifestKey);

    const retry = await call(newLedger(currentScope), await envelope(currentScope, upload));
    expectIntegrity(retry, 'immutable_object_collision');
    expect(retry.body.operation_id).toBe(rejected.body.operation_id);
    expect(retry.body.newly_recorded).toBe(false);
    const afterRetry = (
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) })
    ).objects.map(({ key, size }) => ({ key, size }));
    expect(afterRetry).toEqual(beforeRetry);
  });

  it('rejects a storage-cap upload before the first R2 mutation and blocks archive status', async () => {
    const currentScope = scope('codex', `storage-cap-${crypto.randomUUID()}`);
    const budgetStub = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    const filler = {
      objectKey: `budget/filler-${crypto.randomUUID()}`,
      objectClass: 'agent_archive_chunk' as const,
      bytes: ARCHIVE_STORAGE_CAP_BYTES - 1,
      expiresAt: null,
    };
    await budgetStub.reserveStorage({ orgId: currentScope.orgId, objects: [filler] });
    await budgetStub.commitStorage({ orgId: currentScope.orgId, objects: [filler] });
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'storage-cap-record',
      '{"storage_cap":true}',
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
    const stub = newLedger(currentScope);
    const result = await call(stub, await envelope(currentScope, upload));
    expect(result.response.status).toBe(507);
    expect(result.body).toEqual({ error: 'storage_cap_exceeded' });
    const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(stored.objects).toHaveLength(0);
    const ledgerState = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
    ]);
    expect(ledgerState).toHaveLength(0);
    const pendingIntents = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ status: string }>('SELECT status FROM pending_intents'),
    ]);
    expect(pendingIntents).toHaveLength(0);

    __resetPolicyCache();
    const collectorSecret = 'archive-cap-fact-ingest-secret';
    const collectorKey = `collector:${await sha256Hex(collectorSecret)}`;
    const queueSend = vi.fn(async () => {});
    const agentEnv = {
      COLLECTOR_CREDS: {
        get: async (key: string) =>
          key === collectorKey
            ? JSON.stringify({
                orgId: currentScope.orgId,
                userId: currentScope.userId,
                collectorId: 'collector-1',
                expiresAt: Date.now() + 60_000,
                status: 'active',
                createdAt: Date.now(),
              })
            : null,
      },
      AGENT_QUEUE: { sendBatch: queueSend },
      AGENT_INGEST_LIMITER: { limit: async () => ({ success: true }) },
      CONVEX_SITE_URL: 'https://agent-convex.test',
      AGENT_INGEST_SHARED_SECRET: 'agent-shared-secret',
    } as unknown as AgentIngestEnv;
    const previousFetch = globalThis.fetch;
    const agentFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        request.method === 'GET' &&
        url.origin === 'https://agent-convex.test' &&
        url.pathname === '/agent-ingest/compatibility-policy'
      ) {
        return new Response(
          JSON.stringify({
            minDesktopVersion: '1.0.0',
            minParserVersion: '1.0.0',
            denylistedVersions: [],
            updatedAt: Date.now(),
          }),
          { status: 200 },
        );
      }
      if (
        request.method === 'POST' &&
        url.origin === 'https://agent-convex.test' &&
        url.pathname === '/agent-ingest/claim-sessions'
      ) {
        const body = await request.json();
        if (
          typeof body !== 'object' ||
          body === null ||
          !('sessionPks' in body) ||
          !Array.isArray(body.sessionPks) ||
          !body.sessionPks.every((value): value is string => typeof value === 'string')
        ) {
          throw new Error('claim request malformed');
        }
        return new Response(
          JSON.stringify({
            results: body.sessionPks.map((sessionPk) => ({
              sessionPk,
              status: 'claimed',
              ownerUserId: currentScope.userId,
            })),
          }),
          { status: 200 },
        );
      }
      return previousFetch(input, init);
    });
    try {
      const ingestContext = createExecutionContext();
      const ingestResponse = await agentIngestApp.fetch(
        new Request('https://agent.test/v1/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': collectorSecret,
          },
          body: JSON.stringify(agentIngestEnvelope()),
        }),
        agentEnv,
        ingestContext,
      );
      await waitOnExecutionContext(ingestContext);
      expect(ingestResponse.status).toBe(202);
      expect(await ingestResponse.json()).toMatchObject({ accepted: true, sessions: 1 });
      expect(queueSend).toHaveBeenCalledTimes(1);
    } finally {
      agentFetch.mockRestore();
    }
    const outbox = await runInDurableObject(budgetStub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload: string }>(
        'SELECT payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(JSON.parse(outbox[0]!.payload)).toMatchObject({
      orgId: currentScope.orgId,
      storedBytes: ARCHIVE_STORAGE_CAP_BYTES - 1,
      lifecycle: 'blocked',
    });
  });

  it('retains a durable intent when the storage reservation result is ambiguous', async () => {
    const currentScope = scope('codex', `storage-reservation-${crypto.randomUUID()}`);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'storage-reservation-record',
      '{"storage_reservation":true}',
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
    const request = await envelope(currentScope, upload);
    const stub = newLedger(currentScope);
    const ambiguousEnv = {
      ...runtimeEnv,
      STORAGE_BUDGET: {
        getByName: () => ({
          reserveStorage: async () => {
            throw new Error('storage_reservation_result_ambiguous');
          },
        }),
      },
    } as unknown as ArchiveApiEnv;

    const failure = await runInDurableObject(stub, async (_instance, state) => {
      try {
        await commitArchiveSession(state.storage, ambiguousEnv, request);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(failure).toBe('storage_reservation_result_ambiguous');
    const pending = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM pending_intents WHERE status IN ('building', 'ready', 'write_authorized')",
      ),
    ]);
    expect(pending).toEqual([{ status: 'ready' }]);
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) }),
    ).toMatchObject({ objects: [] });

    const recovered = await call(stub, request);
    expect(recovered.response.status).toBe(200);
    expect(recovered.body).toMatchObject({ generation: 1 });
  });

  it('removes a definitely unwritten intent after a relaunched reservation is capped', async () => {
    const currentScope = scope('codex', `pre-reservation-cap-${crypto.randomUUID()}`);
    const randomPayload = new Uint8Array(12_000);
    crypto.getRandomValues(randomPayload);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'large-unwritten-record',
      JSON.stringify({ payload: base64(randomPayload) }),
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
    const request = await envelope(currentScope, upload);
    const stub = newLedger(currentScope);
    const abortBeforeReservation = {
      ...runtimeEnv,
      STORAGE_BUDGET: {
        getByName: () => ({
          reserveStorage: async () => {
            throw new Error('abort_before_storage_reservation');
          },
        }),
      },
    } as unknown as ArchiveApiEnv;

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        commitArchiveSession(state.storage, abortBeforeReservation, request),
      ),
    ).rejects.toThrow('abort_before_storage_reservation');
    const persisted = await runInDurableObject(stub, (_instance, state) => {
      const pending = readPendingIntent(state.storage);
      return {
        status: pending?.status,
        bytes: pending?.objects.reduce(
          (total, object) => total + new TextEncoder().encode(object.body).byteLength,
          0,
        ),
      };
    });
    expect(persisted.status).toBe('ready');
    expect(persisted.bytes).toBeGreaterThan(5_000);
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) }),
    ).toMatchObject({ objects: [] });

    const budgetStub = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    const filler = {
      objectKey: `budget/${crypto.randomUUID()}`,
      objectClass: 'agent_archive_chunk' as const,
      bytes: ARCHIVE_STORAGE_CAP_BYTES - 5_000,
      expiresAt: null,
    };
    await expect(
      budgetStub.reserveStorage({ orgId: currentScope.orgId, objects: [filler] }),
    ).resolves.toMatchObject({ accepted: true });
    await budgetStub.commitStorage({ orgId: currentScope.orgId, objects: [filler] });

    const rejected = await call(newLedger(currentScope), request);
    expect(rejected.response.status).toBe(507);
    expect(rejected.body).toEqual({ error: 'storage_cap_exceeded' });
    expect(
      await runInDurableObject(stub, (_instance, state) => readPendingIntent(state.storage)),
    ).toBeNull();
    await expect(budgetStub.getStorageBudget({ orgId: currentScope.orgId })).resolves.toMatchObject(
      {
        reservedBytes: 0,
        committedBytes: ARCHIVE_STORAGE_CAP_BYTES - 5_000,
        availableBytes: 5_000,
      },
    );

    const replacement = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'small-replacement-record',
      '{}',
    );
    const replacementUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [replacement],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [replacement],
      ),
      complete_prefix_base64: base64(exactPrefix([replacement])),
    } satisfies ArchiveUploadRequest;
    const replacementResult = await call(
      newLedger(currentScope),
      await envelope(currentScope, replacementUpload),
    );
    expect(replacementResult.response.status).toBe(200);
    expect(replacementResult.body).toMatchObject({ generation: 1 });
  });

  it('holds the one-and-a-half MiB uncompressed chunk boundary', async () => {
    const currentScope = scope('claude', `boundary-${crypto.randomUUID()}`);
    const base: StoredRecord = {
      kind: 'record',
      archive_format_version: 1,
      chain_hash_version: 1,
      source: 'claude',
      source_session_id: currentScope.sourceSessionId,
      source_transcript_part_id: partFor('claude'),
      source_record_identity: 'r1',
      observed_at: 1,
      payload_encoding: 'utf8',
      payload: '',
      content_sha256: `sha256:${'11'.repeat(32)}`,
      chain_sequence: 0,
      previous_chain_hash: `sha256:${'00'.repeat(32)}`,
      chain_hash: `sha256:${'22'.repeat(32)}`,
    };
    let low = 0;
    let high = MAX_CHUNK_BYTES;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = { ...base, payload: 'x'.repeat(mid) };
      if (
        new TextEncoder().encode(`${canonicalElement(candidate)}\n`).byteLength <= MAX_CHUNK_BYTES
      )
        low = mid;
      else high = mid - 1;
    }
    const exact = { ...base, payload: 'x'.repeat(low) };
    expect(new TextEncoder().encode(`${canonicalElement(exact)}\n`).byteLength).toBe(
      MAX_CHUNK_BYTES,
    );
    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const plan = await packNewElements(currentScope, [exact], [exact], {}, 1, key, KEY_VERSION);
    expect(plan.chunks[0]!.plainBytes.byteLength).toBe(MAX_CHUNK_BYTES);
    await expect(
      packNewElements(
        currentScope,
        [
          (({ payload: _payload, ...metadata }) => metadata)({
            ...exact,
            payload: 'x'.repeat(low + 1),
          }),
        ],
        [{ ...exact, payload: 'x'.repeat(low + 1) }],
        {},
        1,
        key,
        KEY_VERSION,
      ),
    ).rejects.toThrow('archive_element_exceeds_chunk_limit');
  });

  it('keeps maximum-length scope identifiers inside the R2 key limit', async () => {
    const currentScope: ArchiveScope = {
      orgId: '组织'.repeat(512),
      userId: 'user',
      contributionId: '贡献'.repeat(512),
      source: 'claude',
      sourceSessionId: 'session'.repeat(146),
    };
    const prefix = await archiveSessionPrefix(currentScope);
    const chunkKey = `${prefix}/chunks/${'a'.repeat(64)}`;
    expect(new TextEncoder().encode(chunkKey).byteLength).toBeLessThan(1024);
    expect(prefix).not.toContain(currentScope.orgId);
    expect(prefix).not.toContain(currentScope.contributionId);
    expect(prefix).not.toContain(currentScope.sourceSessionId);
  });
});
