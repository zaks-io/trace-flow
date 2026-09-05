import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
  decryptArchiveObject,
  sha256Hex,
  unwrapArchiveEncryptionKey,
  MAX_UPLOAD_OBSERVATIONS,
  validateObservation,
  archiveSessionPrefix,
  app,
  prefixChainHash,
  rustWireSessionJson,
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
  newLedger,
} from './ledger.integration.fixtures';
import type {
  ArchiveObjectEnvelope,
  ArchiveScope,
  ArchiveUploadRequest,
  ArchiveApiEnv,
} from './ledger.integration.fixtures';

describe('Archive Session Ledger', () => {
  beforeEach(() => {
    expect(runtimeEnv.ARCHIVE_KEY_WRAPPING_SECRET).toBe(WRAPPING_SECRET);
  });

  it('rejects an over-cap handler upload before resolving the real ledger namespace', async () => {
    const currentScope = scope('codex', `handler-over-cap-${crypto.randomUUID()}`);
    const secret = 'handler-over-cap-collector-secret';
    const hashedSecret = await sha256Hex(secret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'handler-over-cap-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    let idFromNameCalls = 0;
    let keyRequests = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'enrollment-over-cap',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'handler-over-cap-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        keyRequests++;
        throw new Error('key custody must not be reached');
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const realNamespace = runtimeEnv.ARCHIVE_SESSION_LEDGER;
    const guardedNamespace = new Proxy(realNamespace, {
      get(target, property, receiver) {
        if (property === 'idFromName') {
          return (name: string) => {
            idFromNameCalls++;
            return target.idFromName(name);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: guardedNamespace,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;

    try {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': secret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify({
            source_session_id: currentScope.sourceSessionId,
            observations: new Array(MAX_UPLOAD_OBSERVATIONS + 1).fill(null),
            checkpoint: null,
          }),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'upload_too_large' });
      expect(idFromNameCalls).toBe(0);
      expect(keyRequests).toBe(0);
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects).toHaveLength(0);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects malformed uploads before archive key, DO, state, or R2 access', async () => {
    const currentScope = scope('codex', `handler-validation-${crypto.randomUUID()}`);
    const collectorSecret = 'handler-validation-collector-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'handler-validation-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'handler-validation-record',
      '"valid"',
    );
    const validUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const nonJsonRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'handler-validation-non-json',
      'not-json',
    );
    const nonJsonUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [nonJsonRecord],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [nonJsonRecord],
      ),
      complete_prefix_base64: base64(exactPrefix([nonJsonRecord])),
    };
    const emptyCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [],
    );
    const malformedUploads = [
      {
        ...validUpload,
        observations: [
          { ...record, content_sha256: await digest(new TextEncoder().encode('wrong')) },
        ],
      },
      {
        ...validUpload,
        observations: [{ ...record, source_transcript_part_id: 'codex:part:invalid' }],
      },
      { ...validUpload, checkpoint: null },
      {
        ...validUpload,
        prior_checkpoint: emptyCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: `sha256:${'11'.repeat(32)}`,
          appended_prefix_base64: base64(new TextEncoder().encode(`${record.payload}\n`)),
        },
      },
      { ...validUpload, complete_prefix_base64: undefined },
      nonJsonUpload,
    ];
    let idFromNameCalls = 0;
    let keyRequests = 0;
    const realNamespace = runtimeEnv.ARCHIVE_SESSION_LEDGER;
    const guardedNamespace = new Proxy(realNamespace, {
      get(target, property, receiver) {
        if (property === 'idFromName') {
          return (name: string) => {
            idFromNameCalls++;
            return target.idFromName(name);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'handler-validation-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'handler-validation-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        keyRequests++;
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: guardedNamespace,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;
    try {
      for (const [index, upload] of malformedUploads.entries()) {
        const executionContext = createExecutionContext();
        const response = await app.fetch(
          new Request('https://archive.test/v1/archive/uploads', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Trace-Flow-Collector-Secret': collectorSecret,
              'X-Trace-Flow-Archive-Source': currentScope.source,
            },
            body: JSON.stringify(upload),
          }),
          handlerEnv,
          executionContext,
        );
        await waitOnExecutionContext(executionContext);
        expect(response.status).toBe([400, 400, 400, 409, 409, 400][index]);
        await expect(response.json()).resolves.toMatchObject({
          error: 'upload_rejected',
          reason: [
            'payload_hash_mismatch',
            'invalid_transcript_part_id',
            'invalid_checkpoint',
            'historical_prefix_changed',
            'missing_historical_prefix_proof',
            'checkpoint_prefix_unverifiable',
          ][index],
        });
      }
      expect(idFromNameCalls).toBe(0);
      expect(keyRequests).toBe(0);
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects).toHaveLength(0);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects lone surrogate scope values before deriving archive prefixes', async () => {
    const currentScope = scope('claude', 'well-formed-unicode');
    const replacementPrefix = await archiveSessionPrefix({
      ...currentScope,
      sourceSessionId: 'session-\ufffd',
    });
    expect(replacementPrefix).toContain('/sessions/claude/');
    for (const sourceSessionId of ['session-\ud800', 'session-\udc00']) {
      await expect(
        archiveSessionPrefix({ ...currentScope, sourceSessionId }),
      ).rejects.toMatchObject({ errorClass: 'invalid_scope' });
    }
    const validRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'identity-valid',
      '{}',
    );
    for (const surrogate of ['\ud800', '\udc00']) {
      await expect(
        validateObservation(
          { ...validRecord, source_record_identity: `identity-${surrogate}` },
          { source: currentScope.source, sourceSessionId: currentScope.sourceSessionId },
        ),
      ).rejects.toMatchObject({ errorClass: 'invalid_record_identity' });
      for (const field of ['orgId', 'userId', 'contributionId'] as const) {
        await expect(
          archiveSessionPrefix({
            ...currentScope,
            [field]: `${currentScope[field]}-${surrogate}`,
          }),
        ).rejects.toMatchObject({ errorClass: 'invalid_scope' });
      }
    }
  });

  it('propagates concurrent handler acknowledgements for two enrolled collectors', async () => {
    const currentScope = scope('claude', `handler-first-use-${crypto.randomUUID()}`);
    const identities = [
      { secret: 'handler-collector-secret-one', collectorId: 'handler-collector-one' },
      { secret: 'handler-collector-secret-two', collectorId: 'handler-collector-two' },
    ];
    const hashedIdentities = await Promise.all(
      identities.map(async (identity) => ({
        ...identity,
        hashedSecret: await sha256Hex(identity.secret),
      })),
    );
    for (const identity of hashedIdentities) {
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

    const policyRequests: { collectorId: string; hashedSecret: string }[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.origin !== 'https://archive-convex.test') {
        throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
      }
      if (url.pathname === '/archive-api/authorize-write') {
        const body = await request.json<{ collectorId?: unknown; hashedSecret?: unknown }>();
        const identity = hashedIdentities.find(
          (candidate) =>
            candidate.collectorId === body.collectorId &&
            candidate.hashedSecret === body.hashedSecret,
        );
        if (!identity) return Response.json({ allowed: false, reason: 'not_enrolled' });
        policyRequests.push({
          collectorId: identity.collectorId,
          hashedSecret: identity.hashedSecret,
        });
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
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
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
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'handler-record-1',
      '"HANDLER_PLAINTEXT_MARKER"',
    );
    const upload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    };

    try {
      const send = async (secret: string, requestUpload = upload) => {
        const executionContext = createExecutionContext();
        const response = await app.fetch(
          new Request('https://archive.test/v1/archive/uploads', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Trace-Flow-Collector-Secret': secret,
              'X-Trace-Flow-Archive-Source': currentScope.source,
            },
            body: JSON.stringify(requestUpload),
          }),
          handlerEnv,
          executionContext,
        );
        await waitOnExecutionContext(executionContext);
        return { response, body: await response.json<Record<string, unknown>>() };
      };
      const results = await Promise.all(identities.map((identity) => send(identity.secret)));
      const first = results[0];
      const second = results[1];
      if (!first || !second) throw new Error('handler acknowledgement missing');
      expect(first.response.status).toBe(200);
      expect(second.response.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(first.body).toMatchObject({
        status: 'acknowledged',
        source: currentScope.source,
        source_session_id: currentScope.sourceSessionId,
        contribution_id: currentScope.contributionId,
        appended_records: 1,
        generation: 1,
      });
      const unchangedPrefix = new TextEncoder().encode(`${record.payload}\n`);
      const unchanged = await send(identities[1]!.secret, {
        ...upload,
        complete_prefix_base64: base64(unchangedPrefix),
      });
      expect(unchanged.response.status).toBe(200);
      expect(unchanged.body).toMatchObject({
        duplicate: false,
        generation: 1,
        record_count: 1,
        manifest_key: first.body.manifest_key,
      });

      const changedPrefix = new TextEncoder().encode(`\n${record.payload}\n`);
      const changed = await send(identities[1]!.secret, {
        ...upload,
        checkpoint: {
          ...upload.checkpoint,
          last_complete_byte_offset: changedPrefix.byteLength,
          observed_file_size: changedPrefix.byteLength,
          complete_prefix_sha256: await digest(changedPrefix),
          prefix_chain_sha256: await prefixChainHash(undefined, changedPrefix),
        },
        complete_prefix_base64: base64(changedPrefix),
      });
      expect(changed.response.status).toBe(409);
      expect(changed.body).toMatchObject({
        error: 'upload_rejected',
        reason: 'historical_prefix_changed',
      });
      expect(new Set(policyRequests.map((request) => request.collectorId))).toEqual(
        new Set(identities.map((identity) => identity.collectorId)),
      );
      expect(policyRequests).toHaveLength(identities.length * 4);

      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(listed.objects).toHaveLength(2);
      const stateRows = await runInDurableObject(newLedger(currentScope), (_instance, state) => [
        ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
      ]);
      expect(JSON.parse(stateRows[0]!.data)).toMatchObject({ generation: 1 });
      const wrapped = await archiveKey(currentScope.orgId);
      const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
        orgId: currentScope.orgId,
        keyVersion: KEY_VERSION,
        wrappingSecretBase64: WRAPPING_SECRET,
      });
      for (const listedObject of listed.objects) {
        const raw = await runtimeEnv.ARCHIVE_STORAGE.get(listedObject.key);
        if (!raw) throw new Error('archive object missing');
        const rawText = await raw.text();
        expect(rawText).not.toContain(record.payload);
        const envelope: ArchiveObjectEnvelope = JSON.parse(rawText);
        expect(envelope.objectKey).toBe(listedObject.key);
        expect(envelope.ciphertext).toEqual(expect.any(String));
        await expect(
          decryptArchiveObject(envelope, {
            key,
            orgId: currentScope.orgId,
            objectKey: listedObject.key,
            objectClass: envelope.objectClass,
            keyVersion: KEY_VERSION,
          }),
        ).resolves.toBeInstanceOf(Uint8Array);
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('deduplicates concurrent stale deltas from two enrolled collectors', async () => {
    const currentScope = scope('codex', `handler-stale-delta-${crypto.randomUUID()}`);
    const identities = [
      { secret: 'stale-delta-collector-one', collectorId: 'stale-delta-one' },
      { secret: 'stale-delta-collector-two', collectorId: 'stale-delta-two' },
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
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
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
      'codex:part:primary:codex:line:0',
      '"one"',
      100,
    );
    const firstCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [firstRecord],
    );
    const firstUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [firstRecord],
      checkpoint: firstCheckpoint,
      complete_prefix_base64: base64(exactPrefix([firstRecord])),
    };
    const secondAt101 = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'codex:part:primary:codex:line:1',
      '"two"',
      101,
    );
    const secondAt202 = { ...secondAt101, observed_at: 202 };
    const suffix = new TextEncoder().encode(`${secondAt101.payload}\n`);
    const deltaCheckpoint = {
      ...(await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [firstRecord, secondAt101],
      )),
      first_observed_at: firstCheckpoint.first_observed_at,
      prefix_chain_sha256: await prefixChainHash(firstCheckpoint.prefix_chain_sha256, suffix),
    };
    const deltaUpload = (
      record: Awaited<ReturnType<typeof observation>>,
    ): ArchiveUploadRequest => ({
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: deltaCheckpoint,
      prior_checkpoint: firstCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
        appended_prefix_base64: base64(suffix),
      },
    });
    const send = async (secret: string, upload: ArchiveUploadRequest) => {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': secret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(upload),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      return { response, body: await response.json<Record<string, unknown>>() };
    };
    try {
      const initial = await send(enrolled[0]!.secret, firstUpload);
      expect(initial.response.status).toBe(200);
      const [firstDelta, secondDelta] = await Promise.all([
        send(enrolled[0]!.secret, deltaUpload(secondAt101)),
        send(enrolled[1]!.secret, deltaUpload(secondAt202)),
      ]);
      expect(firstDelta.response.status).toBe(200);
      expect(secondDelta.response.status).toBe(200);
      expect(firstDelta.body.manifest_key).toBe(secondDelta.body.manifest_key);
      expect(firstDelta.body).toMatchObject({ record_count: 2, generation: 2 });
      expect(secondDelta.body).toMatchObject({ record_count: 2, generation: 2 });
      expect([firstDelta.body.appended_records, secondDelta.body.appended_records].sort()).toEqual([
        0, 1,
      ]);
      const state = await runInDurableObject(
        newLedger(currentScope),
        (_instance, durableState) => ({
          elements: [
            ...durableState.storage.sql.exec<{ count: number }>(
              'SELECT COUNT(*) AS count FROM ledger_elements',
            ),
          ][0]?.count,
          versions: [
            ...durableState.storage.sql.exec<{ count: number }>(
              'SELECT COUNT(*) AS count FROM ledger_record_versions',
            ),
          ][0]?.count,
        }),
      );
      expect(state).toEqual({ elements: 4, versions: 2 });
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects).toHaveLength(6);
      for (const object of stored.objects) {
        const raw = await runtimeEnv.ARCHIVE_STORAGE.get(object.key);
        expect(await raw!.text()).not.toContain(secondAt101.payload);
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('accepts serialized collector-archive wire requests through the handler', async () => {
    const currentScope: ArchiveScope = {
      orgId: 'org-rust-wire',
      userId: 'user-rust-wire',
      contributionId: 'contribution-rust-wire',
      source: 'claude',
      sourceSessionId: 'session-1',
    };
    const collectorSecret = 'rust-wire-collector-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'rust-wire-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'rust-wire-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'rust-wire-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
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
    const wire = JSON.parse(rustWireSessionJson) as Record<string, ArchiveUploadRequest>;
    const send = async (upload: ArchiveUploadRequest) => {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': collectorSecret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(upload),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      return { response, body: await response.json<Record<string, unknown>>() };
    };
    try {
      const initial = await send(wire.initial!);
      expect(initial.response.status).toBe(200);
      expect(initial.body.record_count).toBe(1);
      const eof = await send(wire.eof!);
      expect(eof.response.status).toBe(200);
      expect(eof.body).toMatchObject({ record_count: 2, appended_records: 1 });
      const append = await send(wire.append!);
      expect(append.response.status).toBe(200);
      expect(append.body).toMatchObject({ record_count: 3, appended_records: 1 });
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects.length).toBeGreaterThan(2);
      for (const object of stored.objects) {
        const raw = await runtimeEnv.ARCHIVE_STORAGE.get(object.key);
        expect(await raw!.text()).not.toContain('"uuid":"r');
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('accepts the Rust vertical-tab fixture with the Worker incomplete-tail disposition', async () => {
    const currentScope = scope('claude', 'vertical-tab-session');
    const collectorSecret = 'vertical-tab-fixture-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'vertical-tab-fixture-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'vertical-tab-fixture-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'vertical-tab-fixture-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const wire = JSON.parse(rustWireSessionJson) as Record<string, ArchiveUploadRequest>;
    const context = createExecutionContext();
    try {
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': collectorSecret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(wire.vertical_tab),
        }),
        {
          ...runtimeEnv,
          CONVEX_SITE_URL: 'https://archive-convex.test',
          ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
        },
        context,
      );
      await waitOnExecutionContext(context);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ record_count: 1, appended_records: 1 });
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects.length).toBeGreaterThan(0);
      for (const object of stored.objects) {
        expect(await (await runtimeEnv.ARCHIVE_STORAGE.get(object.key))!.text()).not.toContain(
          '"uuid":"vt"',
        );
      }
    } finally {
      fetchMock.mockRestore();
    }
  });
});
