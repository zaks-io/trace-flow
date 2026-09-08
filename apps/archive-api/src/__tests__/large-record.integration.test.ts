import { describe, expect, it, vi } from 'vitest';
import {
  GENESIS_CHAIN_HASH,
  KEY_VERSION,
  MAX_ARCHIVE_UPLOAD_BYTES,
  MAX_CHUNK_BYTES,
  WRAPPING_SECRET,
  app,
  archiveKey,
  archiveSessionPrefix,
  base64,
  canonicalElement,
  checkpoint,
  createExecutionContext,
  decryptArchiveObject,
  decompress,
  digest,
  exactPrefix,
  fallbackArchiveKeyHttp,
  newLedger,
  observation,
  packNewElements,
  partFor,
  prefixChainHash,
  runInDurableObject,
  runtimeEnv,
  scope,
  sha256Hex,
  unwrapArchiveEncryptionKey,
  waitOnExecutionContext,
} from './ledger.integration.fixtures';
import { buildRecord } from '../archive-chain';
import { ARCHIVE_CHUNK_TARGET_BYTES } from '../archive-contract';
import type {
  ArchiveApiEnv,
  ArchiveObjectEnvelope,
  ArchiveUploadRequest,
} from './ledger.integration.fixtures';

const RAW_RECORD_BYTES = 6_467_360;
const OLD_UPLOAD_LIMIT = 8 * 1024 * 1024;
const OLD_CHUNK_LIMIT = (3 * 1024 * 1024) / 2;

function largeRawRecord(session: string): string {
  const prefix = `{"sessionId":"${session}","uuid":"large","pad":"`;
  const suffix = '"}';
  const paddingLength = RAW_RECORD_BYTES - prefix.length - suffix.length;
  if (paddingLength < 0) throw new Error('large record fixture prefix exceeds target size');
  return `${prefix}${'x'.repeat(paddingLength)}${suffix}`;
}

describe('large archive records', () => {
  it('keeps the ordinary packing target below the single-record hard limit', async () => {
    const currentScope = scope('codex', `chunk-target-${crypto.randomUUID()}`);
    const part = partFor(currentScope.source);
    const firstObservation = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      `${part}:codex:line:0`,
      'x'.repeat(1_000_000),
    );
    const first = await buildRecord(firstObservation, 0, GENESIS_CHAIN_HASH);
    const secondObservation = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      `${part}:codex:line:1`,
      'x'.repeat(1_000_000),
    );
    const second = await buildRecord(secondObservation, 1, first.chain_hash);
    const elements = [first, second];
    const sizes = elements.map(
      (element) => new TextEncoder().encode(`${canonicalElement(element)}\n`).byteLength,
    );
    expect(sizes.every((size) => size <= ARCHIVE_CHUNK_TARGET_BYTES)).toBe(true);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeGreaterThan(
      ARCHIVE_CHUNK_TARGET_BYTES,
    );
    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const plan = await packNewElements(
      currentScope,
      elements.map(({ payload: _payload, ...metadata }) => metadata),
      elements,
      {},
      1,
      key,
      KEY_VERSION,
    );
    expect(plan.chunks).toHaveLength(2);
  });

  it('durably acknowledges a measured-size append through the Worker and ledger', async () => {
    const currentScope = scope('codex', `large-record-${crypto.randomUUID()}`);
    const collectorSecret = 'large-record-collector-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'large-record-collector',
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
          enrollmentId: 'large-record-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'large-record-collector',
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
    const part = partFor(currentScope.source);
    const firstRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      `${part}:codex:line:0`,
      '{"small":true}',
    );
    const firstCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      [firstRecord],
    );
    const firstUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [firstRecord],
      checkpoint: firstCheckpoint,
      complete_prefix_base64: base64(exactPrefix([firstRecord])),
    };
    const payload = largeRawRecord(currentScope.sourceSessionId);
    const payloadBytes = new TextEncoder().encode(payload);
    expect(payloadBytes.byteLength).toBe(RAW_RECORD_BYTES);
    const largeRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      `${part}:codex:line:1`,
      payload,
    );
    const appendedPrefix = new TextEncoder().encode(`${payload}\n`);
    const fullPrefix = exactPrefix([firstRecord, largeRecord]);
    const appendCheckpoint = {
      ...(await checkpoint(currentScope.source, currentScope.sourceSessionId, part, [
        firstRecord,
        largeRecord,
      ])),
      complete_prefix_sha256: await digest(fullPrefix),
      prefix_chain_sha256: await prefixChainHash(
        firstCheckpoint.prefix_chain_sha256,
        appendedPrefix,
      ),
      first_observed_at: firstCheckpoint.first_observed_at,
    };
    const appendUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [largeRecord],
      checkpoint: appendCheckpoint,
      prior_checkpoint: firstCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
        appended_prefix_base64: base64(appendedPrefix),
      },
    };
    const appendBody = JSON.stringify(appendUpload);
    const appendBodyBytes = new TextEncoder().encode(appendBody).byteLength;
    expect(appendBodyBytes).toBe(15_092_316);
    expect(appendBodyBytes).toBeGreaterThan(OLD_UPLOAD_LIMIT);
    expect(appendBodyBytes).toBeLessThanOrEqual(MAX_ARCHIVE_UPLOAD_BYTES);
    const storedRecord = await buildRecord(largeRecord, 2, GENESIS_CHAIN_HASH);
    const storedRecordBytes = new TextEncoder().encode(
      `${canonicalElement(storedRecord)}\n`,
    ).byteLength;
    expect(storedRecordBytes).toBe(6_467_997);
    expect(storedRecordBytes).toBeGreaterThan(OLD_CHUNK_LIMIT);
    expect(storedRecordBytes).toBeLessThanOrEqual(MAX_CHUNK_BYTES);

    const send = async (body: string) => {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': collectorSecret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body,
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      return { response, body: await response.json<Record<string, unknown>>() };
    };

    try {
      const initial = await send(JSON.stringify(firstUpload));
      expect(initial.response.status).toBe(200);
      const appended = await send(appendBody);
      expect(appended.response.status).toBe(200);
      expect(appended.body).toMatchObject({
        status: 'acknowledged',
        duplicate: false,
        source: currentScope.source,
        source_session_id: currentScope.sourceSessionId,
        contribution_id: currentScope.contributionId,
        appended_records: 1,
        appended_checkpoint: true,
        record_count: 2,
        generation: 2,
      });
      const durableState = await runInDurableObject(newLedger(currentScope), (_instance, state) => [
        ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
      ]);
      expect(JSON.parse(durableState[0]!.data)).toMatchObject({
        recordCount: 2,
        generation: 2,
        manifestKey: appended.body.manifest_key,
      });

      const wrapped = await archiveKey(currentScope.orgId);
      const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
        orgId: currentScope.orgId,
        keyVersion: KEY_VERSION,
        wrappingSecretBase64: WRAPPING_SECRET,
      });
      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      let persisted: Record<string, unknown> | undefined;
      for (const listedObject of listed.objects) {
        const object = await runtimeEnv.ARCHIVE_STORAGE.get(listedObject.key);
        if (!object) throw new Error('archive object missing after acknowledgement');
        const envelope = JSON.parse(await object.text()) as ArchiveObjectEnvelope;
        if (envelope.objectClass !== 'chunk') continue;
        const compressed = await decryptArchiveObject(envelope, {
          key,
          orgId: currentScope.orgId,
          objectKey: listedObject.key,
          objectClass: 'chunk',
          keyVersion: KEY_VERSION,
        });
        const plaintext = await decompress(compressed);
        for (const line of new TextDecoder().decode(plaintext).trimEnd().split('\n')) {
          const element = JSON.parse(line) as Record<string, unknown>;
          if (element.source_record_identity === largeRecord.source_record_identity) {
            persisted = element;
          }
        }
      }
      expect(persisted).toMatchObject({
        kind: 'record',
        content_sha256: largeRecord.content_sha256,
        source_record_identity: largeRecord.source_record_identity,
      });
      const persistedPayload = new TextEncoder().encode(String(persisted?.payload));
      expect(persistedPayload.byteLength).toBe(RAW_RECORD_BYTES);
      expect(await digest(persistedPayload)).toBe(largeRecord.content_sha256);
    } finally {
      fetchMock.mockRestore();
    }
  }, 30_000);
});
