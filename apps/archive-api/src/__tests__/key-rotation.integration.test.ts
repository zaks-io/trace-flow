import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@trace-flow/logging';
import {
  createExecutionContext,
  env as workerEnv,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import {
  decryptArchiveObject,
  encryptArchiveObject,
  sha256Hex,
  type ArchiveObjectEnvelope,
} from '@trace-flow/utils';
import {
  ARCHIVE_FORMAT_VERSION,
  CHAIN_HASH_VERSION,
  type ArchiveScope,
  type ArchiveUploadRequest,
} from '../archive-contract';
import { archiveObjectKey, archiveOrganizationPrefix } from '../archive-storage-key';
import { prefixChainHash } from '../archive-prefix-validation';
import { payloadBytes } from '../archive-contract';
import { __resetArchivePolicyCache } from '../enrollment';
import type { StorageBudget } from '../archive-storage-budget';
import type { ArchiveApiEnv } from '../context';
import { app } from '../index';
import { ARCHIVE_ROTATION_TEMP_SUFFIX, mintAndActivateNextKey } from '../archive-key-rotation';
import { recordRotationManifestRoot } from '../archive-key-rotation-audit';
import { decompress } from '../archive-packing';
import { archiveKeyVersionMetadata } from '../archive-r2';
import { ACTIVATION_ID, FakeArchiveCustody, installCustody } from './key-rotation-custody-fixture';
import { base64, compress, cryptoKey, digest, wrapKey } from './key-rotation-crypto-fixture';

const SHARED = 'archive-status-test-secret';

const runtimeEnv = workerEnv as unknown as ArchiveApiEnv;

function budget(orgId: string): DurableObjectStub<StorageBudget> {
  return runtimeEnv.STORAGE_BUDGET.getByName(orgId);
}

function scope(orgId: string, session: string): ArchiveScope {
  return {
    orgId,
    userId: `user-${session}`,
    contributionId: `contribution-${session}`,
    source: 'claude',
    sourceSessionId: session,
  };
}

async function putArchiveObject(input: {
  currentScope: ArchiveScope;
  objectClass: 'chunk' | 'manifest';
  plaintext: string;
  keyVersion: number;
  wrappedKey: string;
}): Promise<{ objectKey: string; body: string; bytes: number }> {
  const key = await cryptoKey(input.currentScope.orgId, input.keyVersion, input.wrappedKey);
  const plaintext = new TextEncoder().encode(input.plaintext);
  const objectKey = await archiveObjectKey(
    input.currentScope,
    input.objectClass === 'chunk' ? 'chunks' : 'manifests',
    await digest(plaintext),
  );
  const encryptedPlaintext = input.objectClass === 'chunk' ? await compress(plaintext) : plaintext;
  const envelope = await encryptArchiveObject(encryptedPlaintext, {
    key,
    orgId: input.currentScope.orgId,
    objectKey,
    objectClass: input.objectClass,
    keyVersion: input.keyVersion,
  });
  const body = JSON.stringify(envelope);
  await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: archiveKeyVersionMetadata(input.keyVersion),
  });
  return { objectKey, body, bytes: new TextEncoder().encode(body).byteLength };
}

async function readEnvelope(objectKey: string): Promise<ArchiveObjectEnvelope> {
  const object = await runtimeEnv.ARCHIVE_STORAGE.get(objectKey);
  if (!object) throw new Error(`missing object ${objectKey}`);
  return JSON.parse(await object.text()) as ArchiveObjectEnvelope;
}

async function decryptStored(
  objectKey: string,
  orgId: string,
  keyVersion: number,
  wrappedKey: string,
): Promise<Uint8Array> {
  const envelope = await readEnvelope(objectKey);
  const plaintext = await decryptArchiveObject(envelope, {
    key: await cryptoKey(orgId, keyVersion, wrappedKey),
    orgId,
    objectKey,
    objectClass: envelope.objectClass,
    keyVersion,
  });
  return envelope.objectClass === 'chunk' ? decompress(plaintext) : plaintext;
}

function plannedBudgetObjects(
  objects: {
    objectKey: string;
    objectClass: 'chunk' | 'manifest';
    bytes: number;
    keyVersion: number;
  }[],
) {
  return objects.map((object) => ({
    objectKey: object.objectKey,
    objectClass:
      object.objectClass === 'chunk'
        ? ('agent_archive_chunk' as const)
        : ('agent_archive_manifest' as const),
    bytes: object.bytes,
    expiresAt: null,
    keyVersion: object.keyVersion,
  }));
}

async function commitObjects(
  orgId: string,
  objects: {
    objectKey: string;
    objectClass: 'chunk' | 'manifest';
    bytes: number;
    keyVersion: number;
  }[],
): Promise<void> {
  const stub = budget(orgId);
  const planned = plannedBudgetObjects(objects);
  const reserved = await stub.reserveStorage({ orgId, objects: planned });
  expect(reserved.accepted).toBe(true);
  await stub.commitStorage({ orgId, objects: planned });
}

async function observation(
  session: string,
  identity: string,
  payload: string,
): Promise<ArchiveUploadRequest['observations'][number]> {
  const bytes = new TextEncoder().encode(payload);
  return {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
    chain_hash_version: CHAIN_HASH_VERSION,
    source: 'claude',
    source_session_id: session,
    source_transcript_part_id: 'claude:part:parent',
    source_record_identity: identity,
    observed_at: 1_700_000_000_000,
    payload_encoding: 'utf8',
    payload,
    content_sha256: await digest(bytes),
  };
}

async function checkpoint(session: string, observations: ArchiveUploadRequest['observations']) {
  const lines = observations.map((item) => new TextEncoder().encode(`${item.payload}\n`));
  const prefix = new Uint8Array(lines.reduce((sum, line) => sum + line.length, 0));
  let offset = 0;
  for (const line of lines) {
    prefix.set(line, offset);
    offset += line.length;
  }
  return {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
    chain_hash_version: CHAIN_HASH_VERSION,
    source: 'claude' as const,
    source_session_id: session,
    source_transcript_part_id: 'claude:part:parent',
    record_count: observations.length,
    last_source_record_identity: observations.at(-1)?.source_record_identity ?? null,
    last_complete_byte_offset: prefix.length,
    observed_file_size: prefix.length,
    complete_prefix_sha256: await digest(prefix),
    prefix_chain_sha256: await prefixChainHash(undefined, prefix),
    first_observed_at: 1_700_000_000_000,
  };
}

function exactPrefix(observations: ArchiveUploadRequest['observations']): Uint8Array {
  const lines = observations.map((item) => {
    const payload = payloadBytes(item);
    const line = new Uint8Array(payload.length + 1);
    line.set(payload);
    line[payload.length] = 0x0a;
    return line;
  });
  const prefix = new Uint8Array(lines.reduce((sum, line) => sum + line.length, 0));
  let offset = 0;
  for (const line of lines) {
    prefix.set(line, offset);
    offset += line.length;
  }
  return prefix;
}

describe('Archive encryption key rotation', () => {
  let custody: FakeArchiveCustody;

  beforeEach(() => {
    __resetArchivePolicyCache();
    custody = new FakeArchiveCustody();
    installCustody(custody);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedOrg(label: string): Promise<{
    orgId: string;
    currentScope: ArchiveScope;
    v1: string;
    v2: string;
    chunkPlaintext: string;
    manifestPlaintext: string;
    objects: {
      objectKey: string;
      objectClass: 'chunk' | 'manifest';
      bytes: number;
      keyVersion: number;
    }[];
  }> {
    const orgId = `org-rotate-${label}-${crypto.randomUUID()}`;
    const currentScope = scope(orgId, `session-${label}`);
    const v1 = await wrapKey(orgId, 1);
    const v2 = await wrapKey(orgId, 2);
    custody.versions.set(1, v1);
    custody.versions.set(2, v2);
    const chunkPlaintext = `${JSON.stringify({ source: 'claude', label })}\n`;
    const manifestPlaintext = JSON.stringify({
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      chain_hash_version: CHAIN_HASH_VERSION,
      source: currentScope.source,
      source_session_id: currentScope.sourceSessionId,
      generation: 1,
      element_count: 1,
      elements: [],
    });
    const chunk = await putArchiveObject({
      currentScope,
      objectClass: 'chunk',
      plaintext: chunkPlaintext,
      keyVersion: 1,
      wrappedKey: v1,
    });
    const manifest = await putArchiveObject({
      currentScope,
      objectClass: 'manifest',
      plaintext: manifestPlaintext,
      keyVersion: 1,
      wrappedKey: v1,
    });
    const objects = [
      {
        objectKey: chunk.objectKey,
        objectClass: 'chunk' as const,
        bytes: chunk.bytes,
        keyVersion: 1,
      },
      {
        objectKey: manifest.objectKey,
        objectClass: 'manifest' as const,
        bytes: manifest.bytes,
        keyVersion: 1,
      },
    ];
    await commitObjects(orgId, objects);
    return { orgId, currentScope, v1, v2, chunkPlaintext, manifestPlaintext, objects };
  }

  async function advanceExpectingError(
    stub: DurableObjectStub<StorageBudget>,
    input: {
      orgId: string;
      limit?: number;
      injectFailure?: 'before_replace' | 'after_replace' | 'after_destroy';
    },
  ): Promise<string> {
    return runInDurableObject(stub, async (instance: StorageBudget) => {
      try {
        await instance.advanceKeyRotation(input);
        return 'advance_succeeded';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
  }

  async function startRotation(orgId: string, operationId = `rotate:${orgId}:1:2`) {
    const stub = budget(orgId);
    await stub.startKeyRotation({
      orgId,
      operationId,
      fromVersion: 1,
      toVersion: 2,
      activationId: ACTIVATION_ID,
    });
    custody.retiringVersion = 1;
    custody.activeVersion = 2;
    custody.operationId = operationId;
    custody.rotationStatus = 'rotating';
    return stub;
  }

  it('keeps old objects readable and encrypts a concurrent upload with the new active key', async () => {
    const { orgId, currentScope, v1, v2, chunkPlaintext, manifestPlaintext, objects } =
      await seedOrg('concurrent');
    const stub = await startRotation(orgId);
    expect(
      await advanceExpectingError(stub, {
        orgId,
        limit: 1,
        injectFailure: 'before_replace',
      }),
    ).toBe('rotation_failure_injected');

    expect(await decryptStored(objects[0]!.objectKey, orgId, 1, v1)).toEqual(
      new TextEncoder().encode(chunkPlaintext),
    );
    expect((await readEnvelope(objects[0]!.objectKey)).keyVersion).toBe(1);

    const session = currentScope.sourceSessionId;
    const first = await observation(session, 'r1', '"one"');
    const upload: ArchiveUploadRequest = {
      source_session_id: session,
      observations: [first],
      checkpoint: await checkpoint(session, [first]),
      complete_prefix_base64: base64(exactPrefix([first])),
    };
    const ledgerId = runtimeEnv.ARCHIVE_SESSION_LEDGER.idFromName(
      JSON.stringify([
        currentScope.orgId,
        currentScope.contributionId,
        currentScope.source,
        currentScope.sourceSessionId,
      ]),
    );
    const ledger = runtimeEnv.ARCHIVE_SESSION_LEDGER.get(ledgerId);
    const response = await ledger.fetch('https://ledger.test/commit', {
      method: 'POST',
      body: JSON.stringify({
        scope: currentScope,
        upload,
        keyVersion: 2,
        wrappedKey: v2,
      }),
    });
    expect(response.status).toBe(200);
    const ack = await response.json<{ manifest_key: string; chunk_keys: string[] }>();
    expect((await readEnvelope(ack.manifest_key)).keyVersion).toBe(2);
    expect(await decryptStored(ack.manifest_key, orgId, 2, v2)).toBeInstanceOf(Uint8Array);
    for (const chunkKey of ack.chunk_keys) {
      expect((await readEnvelope(chunkKey)).keyVersion).toBe(2);
      expect(await decryptStored(chunkKey, orgId, 2, v2)).toBeInstanceOf(Uint8Array);
    }
    expect((await readEnvelope(objects[0]!.objectKey)).keyVersion).toBe(1);
    expect(await decryptStored(objects[1]!.objectKey, orgId, 1, v1)).toEqual(
      new TextEncoder().encode(manifestPlaintext),
    );

    const health = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(health.status).toBe('succeeded');
    expect(custody.destroyCalls).toEqual([
      { keyVersion: 1, liveReferenceCount: 0, operationId: `rotate:${orgId}:1:2` },
    ]);
    expect(custody.versions.has(1)).toBe(false);
    expect(await decryptStored(objects[0]!.objectKey, orgId, 2, v2)).toEqual(
      new TextEncoder().encode(chunkPlaintext),
    );
    expect(await decryptStored(objects[1]!.objectKey, orgId, 2, v2)).toEqual(
      new TextEncoder().encode(manifestPlaintext),
    );
    expect(custody.versions.has(1)).toBe(false);
    expect((await readEnvelope(objects[0]!.objectKey)).keyVersion).toBe(2);
  });

  it('preserves ledger integrity when appending after the committed manifest was rotated', async () => {
    const orgId = `org-rotate-ledger-${crypto.randomUUID()}`;
    const currentScope = scope(orgId, 'session-rotate-ledger');
    const v1 = await wrapKey(orgId, 1);
    const v2 = await wrapKey(orgId, 2);
    custody.versions.set(1, v1);
    custody.versions.set(2, v2);
    const ledgerId = runtimeEnv.ARCHIVE_SESSION_LEDGER.idFromName(
      JSON.stringify([
        currentScope.orgId,
        currentScope.contributionId,
        currentScope.source,
        currentScope.sourceSessionId,
      ]),
    );
    const ledger = runtimeEnv.ARCHIVE_SESSION_LEDGER.get(ledgerId);
    const first = await observation(currentScope.sourceSessionId, 'ledger-r1', '"one"');
    const firstUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [first],
      checkpoint: await checkpoint(currentScope.sourceSessionId, [first]),
      complete_prefix_base64: base64(exactPrefix([first])),
    };
    const firstResponse = await ledger.fetch('https://ledger.test/commit', {
      method: 'POST',
      body: JSON.stringify({
        scope: currentScope,
        upload: firstUpload,
        keyVersion: 1,
        wrappedKey: v1,
      }),
    });
    expect(firstResponse.status).toBe(200);

    const stub = await startRotation(orgId, 'rotate-ledger-v1-v2');
    expect(await stub.advanceKeyRotation({ orgId, limit: 32 })).toMatchObject({
      status: 'succeeded',
    });
    expect(custody.versions.has(1)).toBe(false);

    const second = await observation(currentScope.sourceSessionId, 'ledger-r2', '"two"');
    const secondUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [first, second],
      checkpoint: await checkpoint(currentScope.sourceSessionId, [first, second]),
      complete_prefix_base64: base64(exactPrefix([first, second])),
    };
    const secondResponse = await ledger.fetch('https://ledger.test/commit', {
      method: 'POST',
      body: JSON.stringify({
        scope: currentScope,
        upload: secondUpload,
        keyVersion: 2,
        wrappedKey: v2,
      }),
    });
    expect(secondResponse.status).toBe(200);
    const acknowledgement = await secondResponse.json<{
      duplicate: boolean;
      appended_records: number;
      manifest_key: string;
    }>();
    expect(acknowledgement).toMatchObject({ duplicate: false, appended_records: 1 });
    expect((await readEnvelope(acknowledgement.manifest_key)).keyVersion).toBe(2);
  });

  it('resumes the same rotation idempotently after before_replace and after_replace injection', async () => {
    const { orgId, v1, v2, objects } = await seedOrg('inject');
    const stub = await startRotation(orgId, 'rotate-inject');

    expect(
      await advanceExpectingError(stub, {
        orgId,
        limit: 1,
        injectFailure: 'before_replace',
      }),
    ).toBe('rotation_failure_injected');
    const firstKey = [...objects].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey),
    )[0]!.objectKey;
    expect((await readEnvelope(firstKey)).keyVersion).toBe(1);
    expect(await decryptStored(firstKey, orgId, 1, v1)).toBeInstanceOf(Uint8Array);
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.get(`${firstKey}${ARCHIVE_ROTATION_TEMP_SUFFIX}`),
    ).not.toBeNull();
    expect(custody.destroyCalls).toHaveLength(0);
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBeGreaterThan(0);

    expect(
      await advanceExpectingError(stub, {
        orgId,
        limit: 1,
        injectFailure: 'after_replace',
      }),
    ).toBe('rotation_failure_injected');
    expect((await readEnvelope(firstKey)).keyVersion).toBe(2);
    expect(await decryptStored(firstKey, orgId, 2, v2)).toBeInstanceOf(Uint8Array);
    expect(custody.destroyCalls).toHaveLength(0);

    const first = await stub.advanceKeyRotation({ orgId, limit: 8 });
    const replayStart = await stub.startKeyRotation({
      orgId,
      operationId: 'rotate-inject',
      fromVersion: 1,
      toVersion: 2,
      activationId: ACTIVATION_ID,
    });
    const replay = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(first.status).toBe('succeeded');
    expect(replayStart.status).toBe('succeeded');
    expect(replay.status).toBe('succeeded');
    expect(first.reencryptedCount).toBe(replay.reencryptedCount);
    expect(custody.destroyCalls).toEqual([
      { keyVersion: 1, liveReferenceCount: 0, operationId: 'rotate-inject' },
    ]);
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.get(`${firstKey}${ARCHIVE_ROTATION_TEMP_SUFFIX}`),
    ).toBeNull();
    expect(custody.auditBodies).toHaveLength(1);
    expect(custody.auditBodies[0]).toMatchObject({
      action: 'key_rotation',
      outcome: 'success',
      operationId: 'rotate-inject:success',
      targetKind: 'encryption_key',
      targetId: '2',
    });
    expect(JSON.stringify(custody.auditBodies[0])).not.toContain(v1);
    expect(JSON.stringify(custody.auditBodies[0])).not.toContain(v2);
    expect(JSON.stringify(custody.auditBodies[0])).not.toContain('ciphertext');
    expect(JSON.stringify(custody.auditBodies[0])).not.toContain('chunk-body');
  });

  it('does not destroy the retiring key while reserved objects still reference it', async () => {
    const { orgId, objects } = await seedOrg('reserved');
    const stub = await startRotation(orgId, 'rotate-reserved');
    const reserved = plannedBudgetObjects([
      {
        objectKey: `${objects[0]!.objectKey}-pending`,
        objectClass: 'chunk',
        bytes: 32,
        keyVersion: 1,
      },
    ]);
    expect((await stub.reserveStorage({ orgId, objects: reserved })).accepted).toBe(true);
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBe(3);

    const blocked = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(blocked.status).toBe('rotating');
    expect(blocked.remainingReferences).toBe(1);
    expect(custody.destroyCalls).toHaveLength(0);
    expect(custody.versions.has(1)).toBe(true);
    expect((await readEnvelope(objects[0]!.objectKey)).keyVersion).toBe(2);

    await stub.releaseStorage({ orgId, objects: reserved });
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBe(0);
    const completed = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(completed.status).toBe('succeeded');
    expect(custody.destroyCalls).toEqual([
      { keyVersion: 1, liveReferenceCount: 0, operationId: 'rotate-reserved' },
    ]);
    expect(custody.versions.has(1)).toBe(false);
  });

  it('rejects a late reserve of a destroyed retiring key and resumes a failed rotation without minting another version', async () => {
    const { orgId } = await seedOrg('retired');
    const stub = await startRotation(orgId, 'rotate-retired');
    const completed = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(completed.status).toBe('succeeded');
    const lateReserve = await runInDurableObject(stub, async (instance: StorageBudget) => {
      try {
        await instance.reserveStorage({
          orgId,
          objects: plannedBudgetObjects([
            {
              objectKey: `org/${orgId}/chunks/late-v1`,
              objectClass: 'chunk',
              bytes: 16,
              keyVersion: 1,
            },
          ]),
        });
        return 'accepted';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(lateReserve).toBe('archive_key_version_retired');

    const { orgId: failedOrgId } = await seedOrg('failed-resume');
    await startRotation(failedOrgId, 'rotate-failed-resume');
    custody.rotationStatus = 'failed';
    const executionContext = createExecutionContext();
    const resumed = await app.fetch(
      new Request('https://archive.test/v1/archive/key-rotations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SHARED}`,
        },
        body: JSON.stringify({ orgId: failedOrgId }),
      }),
      runtimeEnv,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      status: 'succeeded',
      fromVersion: 1,
      toVersion: 2,
    });
    expect(custody.activeVersion).toBe(2);
    expect(custody.versions.has(3)).toBe(false);
    expect(custody.versions.has(1)).toBe(false);
  });

  it('rejects an unreserved v1 upload delayed until after v1-to-v2 and v2-to-v3 complete', async () => {
    const { orgId, v1 } = await seedOrg('delayed-two-rotations');
    const delayedScope = scope(orgId, 'session-delayed-v1');
    const record = await observation(delayedScope.sourceSessionId, 'delayed-v1', '"delayed"');
    const delayedUpload: ArchiveUploadRequest = {
      source_session_id: delayedScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(delayedScope.sourceSessionId, [record]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const delayedRequest = new Request('https://ledger.test/commit', {
      method: 'POST',
      body: JSON.stringify({
        scope: delayedScope,
        upload: delayedUpload,
        keyVersion: 1,
        wrappedKey: v1,
      }),
    });

    const stub = await startRotation(orgId, 'rotate-delayed-1-2');
    await expect(stub.advanceKeyRotation({ orgId, limit: 32 })).resolves.toMatchObject({
      status: 'succeeded',
    });
    const v3 = await wrapKey(orgId, 3);
    custody.versions.set(3, v3);
    custody.retiringVersion = 2;
    custody.activeVersion = 3;
    custody.operationId = 'rotate-delayed-2-3';
    custody.rotationStatus = 'rotating';
    await stub.startKeyRotation({
      orgId,
      operationId: 'rotate-delayed-2-3',
      fromVersion: 2,
      toVersion: 3,
      activationId: ACTIVATION_ID,
    });
    await expect(stub.advanceKeyRotation({ orgId, limit: 32 })).resolves.toMatchObject({
      status: 'succeeded',
    });

    const before = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveOrganizationPrefix(orgId),
    });
    const ledgerId = runtimeEnv.ARCHIVE_SESSION_LEDGER.idFromName(
      JSON.stringify([
        delayedScope.orgId,
        delayedScope.contributionId,
        delayedScope.source,
        delayedScope.sourceSessionId,
      ]),
    );
    const ledger = runtimeEnv.ARCHIVE_SESSION_LEDGER.get(ledgerId);
    const response = await ledger.fetch(delayedRequest);
    expect(response.ok).toBe(false);
    expect(
      await runInDurableObject(ledger, (_instance, state) => [
        ...state.storage.sql.exec('SELECT sequence FROM ledger_elements'),
      ]),
    ).toEqual([]);
    const after = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveOrganizationPrefix(orgId),
    });
    expect(after.objects.map((object) => object.key)).toEqual(
      before.objects.map((object) => object.key),
    );
  });

  it('keeps the activation binding when a lost start response is replayed', async () => {
    const { orgId } = await seedOrg('lost-start-response');
    const operationId = 'rotate-lost-start-response';
    const logger = { error: vi.fn() } as unknown as Logger;
    await expect(
      mintAndActivateNextKey(runtimeEnv, orgId, logger, operationId),
    ).resolves.toMatchObject({
      replay: false,
      activationId: ACTIVATION_ID,
      operationId,
    });

    const executionContext = createExecutionContext();
    const replay = await app.fetch(
      new Request('https://archive.test/v1/archive/key-rotations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SHARED}`,
        },
        body: JSON.stringify({ orgId, operationId }),
      }),
      runtimeEnv,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);

    expect(replay.status).toBe(200);
    expect(custody.versions.has(3)).toBe(false);
    expect(custody.auditBodies).toContainEqual(
      expect.objectContaining({
        binding: { kind: 'activation', activationId: ACTIVATION_ID },
        operationId: `${operationId}:success`,
      }),
    );
  });

  it('retries a durable success audit without destroying twice or changing terminal state', async () => {
    const { orgId } = await seedOrg('audit-retry');
    custody.auditFailuresRemaining = 1;
    const stub = await startRotation(orgId, 'rotate-audit-retry');
    await expect(stub.advanceKeyRotation({ orgId, limit: 32 })).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(custody.auditBodies).toHaveLength(1);
    expect(custody.destroyCalls).toHaveLength(1);
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec('SELECT operation_id FROM archive_key_rotation_audit_outbox'),
      ]),
    ).toHaveLength(1);

    await expect(stub.advanceKeyRotation({ orgId, limit: 32 })).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(custody.auditBodies).toHaveLength(2);
    expect(custody.destroyCalls).toHaveLength(1);
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec('SELECT operation_id FROM archive_key_rotation_audit_outbox'),
      ]),
    ).toHaveLength(0);
    await stub.advanceKeyRotation({ orgId, limit: 32 });
    expect(custody.auditBodies).toHaveLength(2);
  });

  it('retries a durable failure audit without resuming the failed rotation', async () => {
    const { orgId, objects } = await seedOrg('failed-audit-retry');
    const stub = await startRotation(orgId, 'rotate-failed-audit-retry');
    const firstKey = [...objects].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey),
    )[0]!.objectKey;
    const envelope = await readEnvelope(firstKey);
    const last = envelope.ciphertext.at(-1) ?? 'A';
    await runtimeEnv.ARCHIVE_STORAGE.put(
      firstKey,
      JSON.stringify({
        ...envelope,
        ciphertext: `${envelope.ciphertext.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`,
      }),
      { customMetadata: archiveKeyVersionMetadata(1) },
    );
    custody.auditFailuresRemaining = 1;

    await expect(advanceExpectingError(stub, { orgId, limit: 1 })).resolves.not.toBe(
      'advance_succeeded',
    );
    expect(await stub.getKeyRotationHealth({ orgId })).toMatchObject({ status: 'failed' });
    expect(custody.auditBodies).toHaveLength(1);
    const keyFetchCount = custody.keyFetches.length;

    await expect(stub.advanceKeyRotation({ orgId, limit: 1 })).resolves.toMatchObject({
      status: 'failed',
    });
    expect(custody.auditBodies).toHaveLength(2);
    expect(custody.keyFetches).toHaveLength(keyFetchCount);
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec('SELECT operation_id FROM archive_key_rotation_audit_outbox'),
      ]),
    ).toEqual([]);
  });

  it('retains every manifest root and publishes a bounded complete-set reference', async () => {
    const { orgId } = await seedOrg('manifest-root-set');
    const stub = await startRotation(orgId, 'rotate-root-set');
    await runInDurableObject(stub, (_instance, state) => {
      for (let index = 0; index < 40; index += 1) {
        recordRotationManifestRoot(
          state.storage,
          'rotate-root-set',
          `archive/manifests/${index.toString(16).padStart(64, '0')}`,
        );
      }
    });
    await expect(stub.advanceKeyRotation({ orgId, limit: 32 })).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(custody.auditBodies.at(-1)).toMatchObject({
      action: 'key_rotation',
      outcome: 'success',
      manifestRootCount: 41,
      manifestRootSetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(custody.auditBodies.at(-1)).not.toHaveProperty('manifestRootHash');
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec(
          'SELECT root_hash FROM archive_key_rotation_manifest_roots WHERE operation_id = ?',
          'rotate-root-set',
        ),
      ]),
    ).toHaveLength(41);
  });

  it('does not double-count rotation temp objects in live storage bytes', async () => {
    const { orgId, objects } = await seedOrg('budget');
    const stub = budget(orgId);
    const before = await stub.getStorageBudget({ orgId });
    const tempKey = `${objects[0]!.objectKey}${ARCHIVE_ROTATION_TEMP_SUFFIX}`;
    await runtimeEnv.ARCHIVE_STORAGE.put(tempKey, 'temporary-replacement-bytes');
    let result = await stub.reconcileArchiveInventory({ orgId, limit: 2 });
    while (!result.complete) {
      result = await stub.reconcileArchiveInventory({ orgId, limit: 2 });
    }
    const after = await stub.getStorageBudget({ orgId });
    expect(after.committedBytes).toBe(before.committedBytes);
    expect(after.reservedBytes).toBe(0);
  });

  it('fails closed on ciphertext tamper and wrong key version without destroying the old key', async () => {
    const { orgId, v1, v2, objects } = await seedOrg('tamper');
    const stub = await startRotation(orgId, 'rotate-tamper');
    const firstKey = [...objects].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey),
    )[0]!.objectKey;
    const envelope = await readEnvelope(firstKey);
    const last = envelope.ciphertext.at(-1) ?? 'A';
    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`,
    };
    await runtimeEnv.ARCHIVE_STORAGE.put(firstKey, JSON.stringify(tampered));
    expect(await advanceExpectingError(stub, { orgId, limit: 1 })).toBe(
      'Archive cryptographic operation failed',
    );
    expect(await stub.getKeyRotationHealth({ orgId })).toMatchObject({ status: 'failed' });
    expect(custody.destroyCalls).toHaveLength(0);
    expect(custody.versions.has(1)).toBe(true);
    expect(custody.auditBodies).toEqual([
      expect.objectContaining({
        action: 'key_rotation',
        outcome: 'failure',
        operationId: 'rotate-tamper:failure',
      }),
    ]);
    expect(JSON.stringify(custody.auditBodies[0])).not.toContain(v1);

    try {
      await decryptArchiveObject(envelope, {
        key: await cryptoKey(orgId, 2, v2),
        orgId,
        objectKey: firstKey,
        objectClass: envelope.objectClass,
        keyVersion: 2,
      });
      throw new Error('expected wrong-version decrypt to fail');
    } catch (error) {
      expect((error as Error).message).toBe('Archive cryptographic operation failed');
    }
    const other = objects.find((object) => object.objectKey !== firstKey)!;
    try {
      await decryptArchiveObject(await readEnvelope(other.objectKey), {
        key: await cryptoKey(orgId, 2, v2),
        orgId,
        objectKey: other.objectKey,
        objectClass: other.objectClass,
        keyVersion: 1,
      });
      throw new Error('expected wrong-key decrypt to fail');
    } catch (error) {
      expect((error as Error).message).toBe('Archive cryptographic operation failed');
    }
  });

  it('starts rotation over HTTP and prefers the active key for a later upload', async () => {
    const { orgId, currentScope, v1, chunkPlaintext, objects } = await seedOrg('http');
    custody.versions.set(1, v1);
    custody.activeVersion = 1;

    const denied = await app.fetch(
      new Request('https://archive.test/v1/archive/key-rotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId }),
      }),
      runtimeEnv,
      createExecutionContext(),
    );
    expect(denied.status).toBe(401);

    const executionContext = createExecutionContext();
    const started = await app.fetch(
      new Request('https://archive.test/v1/archive/key-rotations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SHARED}`,
        },
        body: JSON.stringify({ orgId, operationId: `rotate-http:${orgId}` }),
      }),
      runtimeEnv,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    expect(started.status).toBe(200);
    const health = await started.json<{ status: string; toVersion: number }>();
    expect(health.status).toBe('succeeded');
    expect(health.toVersion).toBe(2);
    expect(custody.activeVersion).toBe(2);
    expect((await readEnvelope(objects[0]!.objectKey)).keyVersion).toBe(2);
    const rotated = await decryptStored(objects[0]!.objectKey, orgId, 2, custody.versions.get(2)!);
    expect(rotated).toEqual(new TextEncoder().encode(chunkPlaintext));

    const collectorSecret = `http-rotate-${crypto.randomUUID()}`;
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${await sha256Hex(collectorSecret)}`,
      JSON.stringify({
        orgId,
        userId: currentScope.userId,
        collectorId: 'collector-rotation',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const record = await observation(currentScope.sourceSessionId, 'http-r2', '"http-two"');
    const upload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(currentScope.sourceSessionId, [record]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const uploadCtx = createExecutionContext();
    const uploaded = await app.fetch(
      new Request('https://archive.test/v1/archive/uploads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Collector-Secret': collectorSecret,
          'X-Trace-Flow-Archive-Source': 'claude',
        },
        body: JSON.stringify(upload),
      }),
      runtimeEnv,
      uploadCtx,
    );
    await waitOnExecutionContext(uploadCtx);
    expect(uploaded.status).toBe(200);
    const ack = await uploaded.json<{ manifest_key: string }>();
    expect((await readEnvelope(ack.manifest_key)).keyVersion).toBe(2);

    const healthCtx = createExecutionContext();
    const healthRes = await app.fetch(
      new Request(`https://archive.test/v1/archive/key-rotations/${orgId}`, {
        headers: { Authorization: `Bearer ${SHARED}` },
      }),
      runtimeEnv,
      healthCtx,
    );
    await waitOnExecutionContext(healthCtx);
    expect(healthRes.status).toBe(200);
    await expect(healthRes.json()).resolves.toMatchObject({ status: 'succeeded', toVersion: 2 });
  });

  it('resumes destroy after the retiring key is already gone', async () => {
    const { orgId, objects, v2, chunkPlaintext } = await seedOrg('lost-destroy');
    const stub = await startRotation(orgId, 'rotate-lost-destroy');
    expect(
      await advanceExpectingError(stub, { orgId, limit: 8, injectFailure: 'after_destroy' }),
    ).toBe('rotation_failure_injected');
    expect(custody.versions.has(1)).toBe(false);
    expect(custody.rotationStatus).toBe('succeeded');
    expect(await stub.getKeyRotationHealth({ orgId })).toMatchObject({ status: 'rotating' });
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBe(0);
    const v1FetchesAfterDestroy = custody.keyFetches.filter((version) => version === 1).length;
    const resumed = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(resumed.status).toBe('succeeded');
    expect(custody.destroyCalls).toEqual([
      { keyVersion: 1, liveReferenceCount: 0, operationId: 'rotate-lost-destroy' },
      { keyVersion: 1, liveReferenceCount: 0, operationId: 'rotate-lost-destroy' },
    ]);
    expect(custody.keyFetches.filter((version) => version === 1)).toHaveLength(
      v1FetchesAfterDestroy,
    );
    expect(custody.versions.has(1)).toBe(false);
    expect(custody.auditBodies).toEqual([
      expect.objectContaining({
        action: 'key_rotation',
        outcome: 'success',
        operationId: 'rotate-lost-destroy:success',
      }),
    ]);
    expect(await decryptStored(objects[0]!.objectKey, orgId, 2, v2)).toEqual(
      new TextEncoder().encode(chunkPlaintext),
    );
  });
});
