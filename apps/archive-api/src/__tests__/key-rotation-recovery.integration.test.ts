import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import {
  createArchiveEncryptionKeyVersion,
  decryptArchiveObject,
  encryptArchiveObject,
  serializeArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
  type ArchiveObjectEnvelope,
} from '@trace-flow/utils';
import { ARCHIVE_FORMAT_VERSION, CHAIN_HASH_VERSION, type ArchiveScope } from '../archive-contract';
import { archiveObjectKey } from '../archive-storage-key';
import { __resetArchivePolicyCache } from '../enrollment';
import type { StorageBudget } from '../archive-storage-budget';
import type { ArchiveApiEnv } from '../context';
import { ARCHIVE_ROTATION_TEMP_SUFFIX, commitRotationReplacement } from '../archive-key-rotation';
import { decompress } from '../archive-packing';

const WRAPPING_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const CONVEX = 'https://archive-convex.test';
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

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
  readonly keyFetches: number[] = [];
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
      this.keyFetches.push(keyVersion);
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

describe('Archive encryption key rotation recovery fences', () => {
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

  it('does not accept a relabeled envelope on the already-new path', async () => {
    const { orgId, v1, objects } = await seedOrg('already-new');
    const stub = await startRotation(orgId, 'rotate-already-new');
    const firstKey = [...objects].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey),
    )[0]!.objectKey;
    const envelope = await readEnvelope(firstKey);
    await runtimeEnv.ARCHIVE_STORAGE.put(firstKey, JSON.stringify({ ...envelope, keyVersion: 2 }));
    expect(await advanceExpectingError(stub, { orgId, limit: 1 })).toBe(
      'Archive cryptographic operation failed',
    );
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBe(2);
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 2 })).toBe(0);
    expect(custody.destroyCalls).toHaveLength(0);
    expect(
      await decryptArchiveObject(
        { ...envelope, keyVersion: 1 },
        {
          key: await cryptoKey(orgId, 1, v1),
          orgId,
          objectKey: firstKey,
          objectClass: envelope.objectClass,
          keyVersion: 1,
        },
      ),
    ).toBeInstanceOf(Uint8Array);
  });

  it('does not credit already-new refs when a to-version envelope fails authentication', async () => {
    const { orgId, objects } = await seedOrg('already-new-tamper');
    const stub = await startRotation(orgId, 'rotate-already-new-tamper');
    const firstKey = [...objects].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey),
    )[0]!.objectKey;
    expect(
      await advanceExpectingError(stub, { orgId, limit: 1, injectFailure: 'after_replace' }),
    ).toBe('rotation_failure_injected');
    expect((await readEnvelope(firstKey)).keyVersion).toBe(2);
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBeGreaterThan(0);
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 2 })).toBe(0);
    const envelope = await readEnvelope(firstKey);
    const last = envelope.ciphertext.at(-1) ?? 'A';
    await runtimeEnv.ARCHIVE_STORAGE.put(
      firstKey,
      JSON.stringify({
        ...envelope,
        ciphertext: `${envelope.ciphertext.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`,
      }),
    );
    expect(await advanceExpectingError(stub, { orgId, limit: 1 })).toBe(
      'Archive cryptographic operation failed',
    );
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBeGreaterThan(0);
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 2 })).toBe(0);
    expect(custody.destroyCalls).toHaveLength(0);
    expect(await stub.getKeyRotationHealth({ orgId })).toMatchObject({ status: 'failed' });
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.get(`${firstKey}${ARCHIVE_ROTATION_TEMP_SUFFIX}`),
    ).not.toBeNull();
    expect(custody.versions.has(1)).toBe(true);
  });

  it('does not credit an authenticated target-version object with the wrong content identity', async () => {
    const { orgId, objects, v2 } = await seedOrg('already-new-content');
    const stub = await startRotation(orgId, 'rotate-already-new-content');
    const firstKey = [...objects].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey),
    )[0]!.objectKey;
    expect(
      await advanceExpectingError(stub, { orgId, limit: 1, injectFailure: 'after_replace' }),
    ).toBe('rotation_failure_injected');
    const wrongPlaintext = new TextEncoder().encode('{"source":"claude","wrong":true}\n');
    const wrongBody = JSON.stringify(
      await encryptArchiveObject(await compress(wrongPlaintext), {
        key: await cryptoKey(orgId, 2, v2),
        orgId,
        objectKey: firstKey,
        objectClass: 'chunk',
        keyVersion: 2,
      }),
    );
    await runtimeEnv.ARCHIVE_STORAGE.put(firstKey, wrongBody);

    expect(await advanceExpectingError(stub, { orgId, limit: 1 })).toBe(
      'archive_object_identity_mismatch',
    );
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBeGreaterThan(0);
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 2 })).toBe(0);
    expect(custody.versions.has(1)).toBe(true);
    expect(custody.destroyCalls).toHaveLength(0);
    expect(await runtimeEnv.ARCHIVE_STORAGE.get(firstKey)).not.toBeNull();
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.get(`${firstKey}${ARCHIVE_ROTATION_TEMP_SUFFIX}`),
    ).not.toBeNull();
  });

  it('does not credit a target-version object encrypted with the wrong version key', async () => {
    const { orgId, objects, chunkPlaintext } = await seedOrg('already-new-wrong-key');
    const stub = await startRotation(orgId, 'rotate-already-new-wrong-key');
    const firstKey = [...objects].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey),
    )[0]!.objectKey;
    expect(
      await advanceExpectingError(stub, { orgId, limit: 1, injectFailure: 'after_replace' }),
    ).toBe('rotation_failure_injected');
    const unrelatedV2 = await wrapKey(orgId, 2);
    const wrongBody = JSON.stringify(
      await encryptArchiveObject(await compress(new TextEncoder().encode(chunkPlaintext)), {
        key: await cryptoKey(orgId, 2, unrelatedV2),
        orgId,
        objectKey: firstKey,
        objectClass: 'chunk',
        keyVersion: 2,
      }),
    );
    await runtimeEnv.ARCHIVE_STORAGE.put(firstKey, wrongBody);

    expect(await advanceExpectingError(stub, { orgId, limit: 1 })).toBe(
      'Archive cryptographic operation failed',
    );
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).toBeGreaterThan(0);
    expect(await stub.countKeyVersionReferences({ orgId, keyVersion: 2 })).toBe(0);
    expect(custody.versions.has(1)).toBe(true);
    expect(custody.destroyCalls).toHaveLength(0);
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.get(`${firstKey}${ARCHIVE_ROTATION_TEMP_SUFFIX}`),
    ).not.toBeNull();
  });

  it('does not replace a canonical object changed after the rotation read', async () => {
    const { orgId, objects } = await seedOrg('etag-conflict');
    const stub = await startRotation(orgId, 'rotate-etag-conflict');
    const objectKey = objects[0]!.objectKey;
    const before = await runtimeEnv.ARCHIVE_STORAGE.get(objectKey);
    if (!before) throw new Error(`missing object ${objectKey}`);
    const expectedEtag = before.etag;
    const interveningBody = '{"intervening":true}';
    await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, interveningBody);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      try {
        await commitRotationReplacement(runtimeEnv, state.storage, {
          objectKey,
          replacementBody: '{"replacement":true}',
          operationId: 'rotate-etag-conflict',
          generation: 1,
          fromVersion: 1,
          toVersion: 2,
          expectedEtag,
        });
        return 'wrote';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(result).toBe('archive_key_rotation_conflict');
    await expect(
      runtimeEnv.ARCHIVE_STORAGE.get(objectKey).then((object) => object?.text()),
    ).resolves.toBe(interveningBody);
  });

  it('does not let a stale v1-to-v2 worker overwrite after v2-to-v3 completes', async () => {
    const { orgId, v1, v2, objects, chunkPlaintext, manifestPlaintext } =
      await seedOrg('stale-worker');
    const stub = await startRotation(orgId, 'rotate-stale-v1-v2');
    const objectKey = objects[0]!.objectKey;
    const staleObject = await runtimeEnv.ARCHIVE_STORAGE.get(objectKey);
    if (!staleObject) throw new Error(`missing object ${objectKey}`);
    const staleEtag = staleObject.etag;
    const envelope = JSON.parse(await staleObject.text()) as ArchiveObjectEnvelope;
    const plaintext = await decryptArchiveObject(envelope, {
      key: await cryptoKey(orgId, 1, v1),
      orgId,
      objectKey,
      objectClass: envelope.objectClass,
      keyVersion: 1,
    });
    const staleReplacement = JSON.stringify(
      await encryptArchiveObject(plaintext, {
        key: await cryptoKey(orgId, 2, v2),
        orgId,
        objectKey,
        objectClass: envelope.objectClass,
        keyVersion: 2,
      }),
    );
    const first = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(first.status).toBe('succeeded');
    const v3 = await wrapKey(orgId, 3);
    custody.versions.set(3, v3);
    custody.retiringVersion = 2;
    custody.activeVersion = 3;
    custody.operationId = 'rotate-stale-v2-v3';
    custody.rotationStatus = 'rotating';
    await stub.startKeyRotation({
      orgId,
      operationId: 'rotate-stale-v2-v3',
      fromVersion: 2,
      toVersion: 3,
      activationId: ACTIVATION_ID,
    });
    const second = await stub.advanceKeyRotation({ orgId, limit: 8 });
    expect(second.status).toBe('succeeded');
    const afterV3 = await runtimeEnv.ARCHIVE_STORAGE.get(objectKey);
    if (!afterV3) throw new Error(`missing object ${objectKey}`);
    const v3Body = await afterV3.text();
    expect(JSON.parse(v3Body).keyVersion).toBe(3);
    const stale = await runInDurableObject(stub, async (_instance, state) => {
      try {
        await commitRotationReplacement(runtimeEnv, state.storage, {
          objectKey,
          replacementBody: staleReplacement,
          operationId: 'rotate-stale-v1-v2',
          generation: 1,
          fromVersion: 1,
          toVersion: 2,
          expectedEtag: staleEtag,
        });
        return 'wrote';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(stale).toBe('archive_key_rotation_stale');
    expect(await stub.getKeyRotationHealth({ orgId })).toMatchObject({
      status: 'succeeded',
      operationId: 'rotate-stale-v2-v3',
      fromVersion: 2,
      toVersion: 3,
    });
    const afterStale = await runtimeEnv.ARCHIVE_STORAGE.get(objectKey);
    if (!afterStale) throw new Error(`missing object ${objectKey}`);
    expect(await afterStale.text()).toBe(v3Body);
    expect([...custody.versions.keys()]).toEqual([3]);
    for (const object of objects) {
      expect((await readEnvelope(object.objectKey)).keyVersion).toBe(3);
      expect(await decryptStored(object.objectKey, orgId, 3, v3)).toEqual(
        new TextEncoder().encode(
          object.objectClass === 'chunk' ? chunkPlaintext : manifestPlaintext,
        ),
      );
    }
  });
});
