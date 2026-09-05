import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
  sha256Hex,
  archiveSessionPrefix,
  storageBudgetObject,
  app,
  commitArchiveSession,
  ARCHIVE_STORAGE_CAP_BYTES,
  discardPendingIntent,
  markIntentReady,
  markIntentWriteAuthorized,
  readPendingIntent,
  WRAPPING_SECRET,
  KEY_VERSION,
  runtimeEnv,
  partFor,
  base64,
  exactPrefix,
  digest,
  observation,
  checkpoint,
  fallbackArchiveKeyHttp,
  scope,
  envelope,
  call,
  newLedger,
  ledgerEffects,
  seedPendingCommit,
  expectIntegrity,
  expectAgentFactSyncAccepted,
} from './ledger.integration.fixtures';
import type { ArchiveUploadRequest, ArchiveApiEnv } from './ledger.integration.fixtures';

describe('Archive Session Ledger', () => {
  beforeEach(() => {
    expect(runtimeEnv.ARCHIVE_KEY_WRAPPING_SECRET).toBe(WRAPPING_SECRET);
  });

  it('rejects a bad payload batch without acknowledging or advancing the ledger', async () => {
    const currentScope = scope('claude', `first-failure-${crypto.randomUUID()}`);
    const record = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"first"',
    );
    const badRecord = {
      ...record,
      content_sha256: await digest(new TextEncoder().encode('wrong')),
    };
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint('claude', currentScope.sourceSessionId, partFor('claude'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const stub = newLedger(currentScope);
    const rejected = await call(
      stub,
      await envelope(currentScope, { ...upload, observations: [badRecord] }),
    );
    expectIntegrity(rejected, 'payload_hash_mismatch');
    expect(rejected.body.newly_recorded).toBe(true);
    const stableRetry = await call(newLedger(currentScope), await envelope(currentScope, upload));
    expectIntegrity(stableRetry, 'payload_hash_mismatch');
    expect(stableRetry.body.operation_id).toBe(rejected.body.operation_id);
    expect(stableRetry.body.newly_recorded).toBe(false);
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      ledgerState: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_state',
        ),
      ][0]?.count,
      ledgerElements: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_elements',
        ),
      ][0]?.count,
      integrity: [
        ...durableState.storage.sql.exec<{ error_class: string; operation_id: string }>(
          'SELECT error_class, operation_id FROM ledger_integrity_state WHERE id = 1',
        ),
      ],
    }));
    expect(state).toEqual({
      ledgerState: 0,
      ledgerElements: 0,
      integrity: [
        {
          error_class: 'payload_hash_mismatch',
          operation_id: rejected.body.operation_id,
        },
      ],
    });
    const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(listed.objects).toHaveLength(0);
  });

  it('contains integrity failure to one session while another session commits', async () => {
    const failedScope = scope('codex', `isolated-failure-${crypto.randomUUID()}`);
    const healthyScope = {
      ...failedScope,
      sourceSessionId: `isolated-healthy-${crypto.randomUUID()}`,
    };
    const failedRecord = await observation(
      failedScope.source,
      failedScope.sourceSessionId,
      partFor(failedScope.source),
      'failed-record',
      '{"failed":true}',
    );
    const healthyRecord = await observation(
      healthyScope.source,
      healthyScope.sourceSessionId,
      partFor(healthyScope.source),
      'healthy-record',
      '{"healthy":true}',
    );
    const failedUpload = {
      source_session_id: failedScope.sourceSessionId,
      observations: [
        { ...failedRecord, content_sha256: await digest(new TextEncoder().encode('tampered')) },
      ],
      checkpoint: await checkpoint(
        failedScope.source,
        failedScope.sourceSessionId,
        partFor(failedScope.source),
        [failedRecord],
      ),
      complete_prefix_base64: base64(exactPrefix([failedRecord])),
    };
    const healthyUpload = {
      source_session_id: healthyScope.sourceSessionId,
      observations: [healthyRecord],
      checkpoint: await checkpoint(
        healthyScope.source,
        healthyScope.sourceSessionId,
        partFor(healthyScope.source),
        [healthyRecord],
      ),
      complete_prefix_base64: base64(exactPrefix([healthyRecord])),
    };
    const [failed, healthy] = await Promise.all([
      call(newLedger(failedScope), await envelope(failedScope, failedUpload)),
      call(newLedger(healthyScope), await envelope(healthyScope, healthyUpload)),
    ]);
    expectIntegrity(failed, 'payload_hash_mismatch');
    expect(healthy.response.status).toBe(200);
    expect(healthy.body).toMatchObject({
      status: 'acknowledged',
      source_session_id: healthyScope.sourceSessionId,
      generation: 1,
    });
    const failedObjects = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(failedScope),
    });
    const healthyObjects = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(healthyScope),
    });
    expect(failedObjects.objects).toHaveLength(0);
    expect(healthyObjects.objects).toHaveLength(2);
    await expectAgentFactSyncAccepted(failedScope, 'integrity-fact-sync-secret');
  });

  it('resumes a pending intent after a partial immutable R2 write', async () => {
    const currentScope = scope('codex', `pending-${crypto.randomUUID()}`);
    const transcriptMarker = 'known-transcript-marker-should-not-persist';
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      JSON.stringify({ transcript: transcriptMarker }),
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const { stub, acknowledgement } = await seedPendingCommit(currentScope, upload);
    const authorizedIntent = await runInDurableObject(stub, (_instance, state) => {
      const pending = readPendingIntent(state.storage);
      if (!pending) throw new Error('pending intent missing');
      markIntentReady(state.storage, pending.intentHash);
      markIntentWriteAuthorized(state.storage, pending.intentHash);
      discardPendingIntent(state.storage, pending.intentHash);
      return readPendingIntent(state.storage);
    });
    expect(authorizedIntent).toMatchObject({ status: 'write_authorized' });
    expect(authorizedIntent?.objects.length).toBeGreaterThan(0);
    const persistedIntent = await runInDurableObject(stub, (_instance, state) =>
      [
        ...state.storage.sql.exec<{ data: string }>(
          'SELECT data FROM pending_intent_metadata ORDER BY part_index',
        ),
        ...state.storage.sql.exec<{ data: string }>(
          'SELECT data FROM pending_intent_parts ORDER BY object_index, part_index',
        ),
      ]
        .map(({ data }) => data)
        .join(''),
    );
    expect(persistedIntent).not.toContain(transcriptMarker);
    const before = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(before.objects).toHaveLength(1);

    const retry = await call(stub, await envelope(currentScope, upload));
    expect(retry.response.status).toBe(200);
    expect(retry.body).toEqual(acknowledgement);
    const after = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(after.objects).toHaveLength(2);
    const intentState = await runInDurableObject(
      stub,
      (_instance, state) =>
        [
          ...state.storage.sql.exec<{ status: string }>(
            'SELECT status FROM pending_intents LIMIT 1',
          ),
        ][0]?.status,
    );
    expect(intentState).toBe('committed');
  });

  it('preserves an authorized partial write through a relaunched cap rejection', async () => {
    const currentScope = scope('codex', `authorized-cap-${crypto.randomUUID()}`);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'authorized-partial-record',
      '{"authorized_partial":true}',
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
    let objectReads = 0;
    const partialWriteBucket = {
      get: async (key: string) => {
        objectReads += 1;
        if (objectReads === 3) throw new Error('partial_r2_read_failure');
        return runtimeEnv.ARCHIVE_STORAGE.get(key);
      },
      put: runtimeEnv.ARCHIVE_STORAGE.put.bind(runtimeEnv.ARCHIVE_STORAGE),
      head: runtimeEnv.ARCHIVE_STORAGE.head.bind(runtimeEnv.ARCHIVE_STORAGE),
    } as unknown as R2Bucket;

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        commitArchiveSession(
          state.storage,
          { ...runtimeEnv, ARCHIVE_STORAGE: partialWriteBucket } as ArchiveApiEnv,
          request,
        ),
      ),
    ).rejects.toThrow('partial_r2_read_failure');

    const pending = await runInDurableObject(stub, (_instance, state) =>
      readPendingIntent(state.storage),
    );
    expect(pending).toMatchObject({ status: 'write_authorized' });
    expect(pending?.objects.length).toBeGreaterThan(1);
    const survivingObject = pending!.objects[0]!;
    const survivingBudgetObject = storageBudgetObject(survivingObject);
    await expect(runtimeEnv.ARCHIVE_STORAGE.head(survivingObject.key)).resolves.not.toBeNull();

    const budgetStub = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    const partialSnapshot = await budgetStub.getStorageBudget({ orgId: currentScope.orgId });
    expect(partialSnapshot).toMatchObject({
      reservedBytes: survivingBudgetObject.bytes,
      committedBytes: 0,
    });
    const filler = {
      objectKey: `budget/${crypto.randomUUID()}`,
      objectClass: 'agent_archive_chunk' as const,
      bytes: ARCHIVE_STORAGE_CAP_BYTES - survivingBudgetObject.bytes - 1,
      expiresAt: null,
    };
    await expect(
      budgetStub.reserveStorage({ orgId: currentScope.orgId, objects: [filler] }),
    ).resolves.toMatchObject({ accepted: true });
    const beforeRejection = await budgetStub.getStorageBudget({ orgId: currentScope.orgId });

    const rejected = await call(newLedger(currentScope), request);
    expect(rejected.response.status).toBe(507);
    expect(rejected.body).toEqual({ error: 'storage_cap_exceeded' });
    expect(
      await runInDurableObject(stub, (_instance, state) => readPendingIntent(state.storage)),
    ).toMatchObject({ status: 'write_authorized' });
    const afterRejection = await budgetStub.getStorageBudget({ orgId: currentScope.orgId });
    expect(afterRejection.reservedBytes).toBe(beforeRejection.reservedBytes);
    expect(afterRejection.reservedBytes).toBe(filler.bytes + survivingBudgetObject.bytes);

    await budgetStub.releaseStorage({ orgId: currentScope.orgId, objects: [filler] });
    const recovered = await call(newLedger(currentScope), request);
    expect(recovered.response.status).toBe(200);
    expect(recovered.body).toMatchObject({ generation: 1 });
    await expect(budgetStub.getStorageBudget({ orgId: currentScope.orgId })).resolves.toMatchObject(
      {
        reservedBytes: 0,
        committedBytes: pending!.objects.reduce(
          (total, object) => total + storageBudgetObject(object).bytes,
          0,
        ),
      },
    );
  });

  it.each(['claude', 'codex'] as const)(
    'recovers a disappeared collector intent before an advancing %s upload',
    async (source) => {
      const currentScope = scope(source, `pending-advance-${crypto.randomUUID()}`);
      const firstRecord = await observation(
        source,
        currentScope.sourceSessionId,
        partFor(source),
        source === 'claude' ? 'r1' : '0',
        '"pending-first"',
      );
      const firstUpload = {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: await checkpoint(source, currentScope.sourceSessionId, partFor(source), [
          firstRecord,
        ]),
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      };
      const { stub } = await seedPendingCommit(currentScope, firstUpload);
      const secondRecord = await observation(
        source,
        currentScope.sourceSessionId,
        partFor(source),
        source === 'claude' ? 'r2' : '1',
        '"pending-second"',
      );
      const secondUpload = {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord, secondRecord],
        checkpoint: await checkpoint(source, currentScope.sourceSessionId, partFor(source), [
          firstRecord,
          secondRecord,
        ]),
        complete_prefix_base64: base64(exactPrefix([firstRecord, secondRecord])),
      };

      const firstAdvance = await call(stub, await envelope(currentScope, secondUpload));
      expect(firstAdvance.response.status).toBe(200);
      expect(firstAdvance.body.appended_records).toBe(1);
      expect(firstAdvance.body.record_count).toBe(2);
      expect(firstAdvance.body.generation).toBe(2);
      const objectsAfterAdvance = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });

      const replay = await call(stub, await envelope(currentScope, secondUpload));
      expect(replay.response.status).toBe(200);
      expect(replay.body).toEqual(firstAdvance.body);
      const objectsAfterReplay = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(objectsAfterReplay.objects.map(({ key }) => key).sort()).toEqual(
        objectsAfterAdvance.objects.map(({ key }) => key).sort(),
      );
      const effects = await ledgerEffects(stub, currentScope);
      expect(effects.storage.ledgerElements).toHaveLength(4);
      expect(
        (effects.storage.pendingIntents ?? []).every((intent) => intent.status === 'committed'),
      ).toBe(true);
    },
  );

  it('recovers a pending intent through the real handler for a second enrolled collector', async () => {
    const currentScope = scope('codex', `handler-pending-recovery-${crypto.randomUUID()}`);
    const identities = [
      { secret: crypto.randomUUID(), collectorId: 'pending-recovery-one' },
      { secret: crypto.randomUUID(), collectorId: 'pending-recovery-two' },
    ];
    const enrolled = await Promise.all(
      identities.map(async (identity) => ({
        ...identity,
        hashedSecret: await sha256Hex(identity.secret),
      })),
    );
    for (const identity of enrolled) {
      await runtimeEnv.COLLECTOR_CREDS.put(
        `collector:${identity.hashedSecret}`,
        JSON.stringify({
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: identity.collectorId,
          expiresAt: Date.now() + 3_600_000,
          status: 'active',
          createdAt: Date.now(),
        }),
      );
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        const body = await request.json<{ collectorId?: unknown; hashedSecret?: unknown }>();
        const identity = enrolled.find(
          (candidate) =>
            candidate.collectorId === body.collectorId &&
            candidate.hashedSecret === body.hashedSecret,
        );
        if (!identity) return Response.json({ allowed: false, reason: 'not_enrolled' });
        return Response.json({
          allowed: true,
          enrollmentId: `enrollment-${identity.collectorId}`,
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: identity.collectorId,
          collectorCredentialId: identity.hashedSecret,
        });
      }
      const keyResponse = await fallbackArchiveKeyHttp(url.pathname, currentScope.orgId);
      if (keyResponse) return keyResponse;
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: runtimeEnv.ARCHIVE_SESSION_LEDGER,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;
    const firstRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      '0',
      '"handler-pending-first"',
    );
    const firstUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [firstRecord],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [firstRecord],
      ),
      complete_prefix_base64: base64(exactPrefix([firstRecord])),
    };
    await seedPendingCommit(currentScope, firstUpload);
    const secondRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      '1',
      '"handler-pending-second"',
    );
    const advancingUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [firstRecord, secondRecord],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [firstRecord, secondRecord],
      ),
      complete_prefix_base64: base64(exactPrefix([firstRecord, secondRecord])),
    };
    const send = async (secret: string) => {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': secret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(advancingUpload),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      return { response, body: await response.json<Record<string, unknown>>() };
    };

    try {
      const result = await send(enrolled[1]!.secret);
      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({ record_count: 2, generation: 2 });
      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(listed.objects.length).toBeGreaterThan(2);
      for (const object of listed.objects) {
        const stored = await runtimeEnv.ARCHIVE_STORAGE.get(object.key);
        if (!stored) throw new Error('archive object missing');
        const storedText = await stored.text();
        expect(storedText).not.toContain(firstRecord.payload);
        expect(storedText).not.toContain(secondRecord.payload);
      }
      const replay = await send(enrolled[0]!.secret);
      expect(replay.response.status).toBe(200);
      expect(replay.body).toEqual(result.body);
      const replayObjects = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(replayObjects.objects.map(({ key }) => key).sort()).toEqual(
        listed.objects.map(({ key }) => key).sort(),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    { objectIndex: 0, objectClass: 'chunk' },
    { objectIndex: 1, objectClass: 'manifest' },
  ] as const)(
    'rejects a pending $objectClass object whose stored ciphertext no longer matches the plan',
    async ({ objectIndex }) => {
      const currentScope = scope('codex', `pending-tamper-${crypto.randomUUID()}`);
      const record = await observation(
        'codex',
        currentScope.sourceSessionId,
        partFor('codex'),
        '0',
        '"pending-tamper"',
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
      const pendingBody = await runInDurableObject(
        stub,
        (_instance, state) =>
          [
            ...state.storage.sql.exec<{ data: string }>(
              'SELECT data FROM pending_intent_parts WHERE object_index = ? AND part_index = 0',
              objectIndex,
            ),
          ][0]?.data,
      );
      if (!pendingBody) throw new Error('pending body missing');
      const tampered = JSON.parse(pendingBody) as { ciphertext: string };
      tampered.ciphertext = `${tampered.ciphertext.slice(0, -2)}AA`;
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          'UPDATE pending_intent_parts SET data = ? WHERE object_index = ? AND part_index = 0',
          JSON.stringify(tampered),
          objectIndex,
        );
      });

      const retry = await call(stub, await envelope(currentScope, upload));
      expectIntegrity(retry, 'pending_object_verification_failed');
      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(listed.objects).toHaveLength(1);
      const intentState = await runInDurableObject(stub, (_instance, state) => ({
        ledgerElements: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM ledger_elements',
          ),
        ][0]?.count,
        status: [
          ...state.storage.sql.exec<{ status: string }>(
            'SELECT status FROM pending_intents LIMIT 1',
          ),
        ][0]?.status,
      }));
      expect(intentState).toEqual({ ledgerElements: 0, status: 'building' });
    },
  );

  it('rejects corrupted pending intent metadata before recovery effects', async () => {
    const currentScope = scope('codex', `pending-metadata-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"pending-metadata"',
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
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DELETE FROM pending_intent_metadata');
      state.storage.sql.exec(
        'INSERT INTO pending_intent_metadata (intent_hash, part_index, data) VALUES (?, ?, ?)',
        'unknown',
        0,
        '{',
      );
    });

    const rejected = await call(stub, await envelope(currentScope, upload));
    expectIntegrity(rejected, 'pending_intent_corrupt');
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      ledgerState: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_state',
        ),
      ][0]?.count,
      ledgerElements: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_elements',
        ),
      ][0]?.count,
    }));
    expect(state).toEqual({ ledgerState: 0, ledgerElements: 0 });
    const objects = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(objects.objects).toHaveLength(1);
  });
});
