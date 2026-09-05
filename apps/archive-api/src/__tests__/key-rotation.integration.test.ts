import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  env as workerEnv,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import {
  createArchiveEncryptionKeyVersion,
  decryptArchiveObject,
  encryptArchiveObject,
  serializeArchiveWrappedKeyVersion,
  sha256Hex,
  unwrapArchiveEncryptionKey,
  type ArchiveObjectEnvelope,
} from '@trace-flow/utils';
import {
  ARCHIVE_FORMAT_VERSION,
  CHAIN_HASH_VERSION,
  type ArchiveScope,
  type ArchiveUploadRequest,
} from '../archive-contract';
import { archiveObjectKey } from '../archive-storage-key';
import { prefixChainHash } from '../archive-prefix-validation';
import { payloadBytes } from '../archive-contract';
import { __resetArchivePolicyCache } from '../enrollment';
import type { StorageBudget } from '../archive-storage-budget';
import type { ArchiveApiEnv } from '../context';
import { app } from '../index';
import { ARCHIVE_ROTATION_TEMP_SUFFIX } from '../archive-key-rotation';

const WRAPPING_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const CONVEX = 'https://archive-convex.test';
const SHARED = 'archive-status-test-secret';
const ACTIVATION_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';

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

async function digest(bytes: Uint8Array): Promise<string> {
  return `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const end = Math.min(offset + 0x8000, bytes.length);
    const chars = new Array<string>(end - offset);
    for (let index = offset; index < end; index++) {
      chars[index - offset] = String.fromCharCode(bytes[index]!);
    }
    binary += chars.join('');
  }
  return btoa(binary);
}

async function wrapKey(orgId: string, keyVersion: number): Promise<string> {
  return serializeArchiveWrappedKeyVersion(
    await createArchiveEncryptionKeyVersion({
      orgId,
      keyVersion,
      wrappingSecretBase64: WRAPPING_SECRET,
    }),
  );
}

async function cryptoKey(
  orgId: string,
  keyVersion: number,
  wrappedKey: string,
): Promise<CryptoKey> {
  return unwrapArchiveEncryptionKey(JSON.parse(wrappedKey), {
    orgId,
    keyVersion,
    wrappingSecretBase64: WRAPPING_SECRET,
  });
}

async function putArchiveObject(input: {
  currentScope: ArchiveScope;
  objectClass: 'chunk' | 'manifest';
  identity: string;
  plaintext: string;
  keyVersion: number;
  wrappedKey: string;
}): Promise<{ objectKey: string; body: string; bytes: number }> {
  const key = await cryptoKey(input.currentScope.orgId, input.keyVersion, input.wrappedKey);
  const objectKey = await archiveObjectKey(
    input.currentScope,
    input.objectClass === 'chunk' ? 'chunks' : 'manifests',
    await digest(new TextEncoder().encode(input.identity)),
  );
  const envelope = await encryptArchiveObject(new TextEncoder().encode(input.plaintext), {
    key,
    orgId: input.currentScope.orgId,
    objectKey,
    objectClass: input.objectClass,
    keyVersion: input.keyVersion,
  });
  const body = JSON.stringify(envelope);
  await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body, {
    httpMetadata: { contentType: 'application/json' },
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
  return decryptArchiveObject(envelope, {
    key: await cryptoKey(orgId, keyVersion, wrappedKey),
    orgId,
    objectKey,
    objectClass: envelope.objectClass,
    keyVersion,
  });
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

class FakeArchiveCustody {
  readonly versions = new Map<number, string>();
  activeVersion = 1;
  retiringVersion?: number;
  operationId?: string;
  rotationStatus?: 'rotating' | 'succeeded' | 'failed';
  readonly destroyCalls: {
    keyVersion: number;
    liveReferenceCount: number;
    operationId: string;
  }[] = [];
  readonly auditBodies: Record<string, unknown>[] = [];

  handle(pathname: string, body: Record<string, unknown>): Response {
    if (pathname === '/archive-api/status') {
      return Response.json({ revision: body.revision ?? 1, replay: false });
    }
    if (pathname === '/archive-api/key/active') {
      const wrappedKey = this.versions.get(this.activeVersion);
      if (!wrappedKey) {
        return new Response(JSON.stringify({ error: 'Archive key unavailable' }), { status: 404 });
      }
      return Response.json({
        keyVersion: this.activeVersion,
        wrappedKey,
        retiringKeyVersion: this.retiringVersion,
        rotationOperationId: this.operationId,
        rotationStatus: this.rotationStatus,
      });
    }
    if (pathname === '/archive-api/key/activate') {
      const keyVersion = body.keyVersion as number;
      const wrappedKey = body.wrappedKey as string;
      const operationId = body.operationId as string;
      if (this.operationId === operationId && this.activeVersion === keyVersion) {
        return Response.json({
          fromVersion: this.retiringVersion ?? keyVersion,
          toVersion: keyVersion,
          replay: true,
          operationId,
          activationId: ACTIVATION_ID,
        });
      }
      this.versions.set(keyVersion, wrappedKey);
      this.retiringVersion = this.activeVersion;
      this.activeVersion = keyVersion;
      this.operationId = operationId;
      this.rotationStatus = 'rotating';
      return Response.json({
        fromVersion: this.retiringVersion,
        toVersion: keyVersion,
        replay: false,
        operationId,
        activationId: ACTIVATION_ID,
      });
    }
    if (pathname === '/archive-api/key/destroy-retiring') {
      const liveReferenceCount = body.liveReferenceCount as number;
      const keyVersion = body.keyVersion as number;
      const operationId = body.operationId as string;
      this.destroyCalls.push({ keyVersion, liveReferenceCount, operationId });
      if (liveReferenceCount !== 0) {
        return Response.json(
          { error: 'Archive key still has live object references' },
          { status: 409 },
        );
      }
      if (this.activeVersion === keyVersion) {
        return Response.json({ error: 'Active archive key cannot be destroyed' }, { status: 409 });
      }
      this.versions.delete(keyVersion);
      this.retiringVersion = undefined;
      this.rotationStatus = 'succeeded';
      return Response.json({ destroyed: true });
    }
    if (pathname === '/archive-api/key/rotation-failed') {
      if (this.operationId === body.operationId) this.rotationStatus = 'failed';
      return Response.json({ recorded: true });
    }
    if (pathname === '/archive-api/key') {
      const keyVersion = body.keyVersion as number;
      const wrappedKey = this.versions.get(keyVersion);
      if (!wrappedKey) {
        return new Response(JSON.stringify({ error: 'Archive key unavailable' }), { status: 404 });
      }
      return Response.json({ keyVersion, wrappedKey });
    }
    if (pathname === '/archive-api/audit-events') {
      this.auditBodies.push(body);
      return Response.json({ eventId: `audit-${this.auditBodies.length}`, created: true });
    }
    if (pathname === '/archive-api/authorize-write') {
      return Response.json({
        allowed: true,
        enrollmentId: 'enrollment-rotation',
        contributionId: body.contributionId ?? 'contribution-rotation',
        orgId: body.orgId,
        userId: body.userId,
        collectorId: 'collector-rotation',
        collectorCredentialId: 'cred-rotation',
      });
    }
    throw new Error(`unexpected convex path ${pathname}`);
  }
}

function installCustody(custody: FakeArchiveCustody) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== CONVEX) {
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return custody.handle(url.pathname, body);
  });
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
    const chunk = await putArchiveObject({
      currentScope,
      objectClass: 'chunk',
      identity: `chunk-${label}`,
      plaintext: `chunk-body-${label}`,
      keyVersion: 1,
      wrappedKey: v1,
    });
    const manifest = await putArchiveObject({
      currentScope,
      objectClass: 'manifest',
      identity: `manifest-${label}`,
      plaintext: `manifest-body-${label}`,
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
    return { orgId, currentScope, v1, v2, objects };
  }

  async function advanceExpectingError(
    stub: DurableObjectStub<StorageBudget>,
    input: {
      orgId: string;
      limit?: number;
      injectFailure?: 'before_replace' | 'after_replace';
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
    const { orgId, currentScope, v1, v2, objects } = await seedOrg('concurrent');
    const stub = await startRotation(orgId);
    expect(
      await advanceExpectingError(stub, {
        orgId,
        limit: 1,
        injectFailure: 'before_replace',
      }),
    ).toBe('rotation_failure_injected');

    expect(await decryptStored(objects[0]!.objectKey, orgId, 1, v1)).toEqual(
      new TextEncoder().encode('chunk-body-concurrent'),
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
      new TextEncoder().encode('manifest-body-concurrent'),
    );

    const health = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(health.status).toBe('succeeded');
    expect(custody.destroyCalls).toEqual([
      { keyVersion: 1, liveReferenceCount: 0, operationId: `rotate:${orgId}:1:2` },
    ]);
    expect(custody.versions.has(1)).toBe(false);
    expect(await decryptStored(objects[0]!.objectKey, orgId, 2, v2)).toEqual(
      new TextEncoder().encode('chunk-body-concurrent'),
    );
    expect(await decryptStored(objects[1]!.objectKey, orgId, 2, v2)).toEqual(
      new TextEncoder().encode('manifest-body-concurrent'),
    );
    expect(custody.versions.has(1)).toBe(false);
    expect((await readEnvelope(objects[0]!.objectKey)).keyVersion).toBe(2);
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
    const { orgId, currentScope, v1, objects } = await seedOrg('http');
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
    expect(rotated).toEqual(new TextEncoder().encode('chunk-body-http'));

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
});
