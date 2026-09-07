import {
  decryptArchiveObject,
  encryptArchiveObject,
  parseArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
  type ArchiveObjectEnvelope,
} from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import {
  ARCHIVE_FORMAT_VERSION,
  CHAIN_HASH_VERSION,
  MAX_CHUNK_BYTES,
  MAX_MANIFEST_BYTES,
  ArchiveContractError,
} from './archive-contract';
import {
  assertRotationReplaceAllowed,
  recordRotatedObject,
  rotationTempObjectKey,
  type ArchiveKeyRotationFailureInjection,
  type ArchiveKeyRotationFence,
} from './archive-key-rotation-state';

type BudgetObjectClass = 'agent_archive_chunk' | 'agent_archive_manifest';
type ArchiveObjectClass = 'chunk' | 'manifest';

interface StoredObject {
  body: string;
  etag: string;
}

const MAX_ENCRYPTED_OBJECT_BYTES = Math.ceil((MAX_MANIFEST_BYTES * 4) / 3) + 16_384;

function objectClassFromBudget(value: BudgetObjectClass): ArchiveObjectClass {
  return value === 'agent_archive_chunk' ? 'chunk' : 'manifest';
}

function parseEnvelope(body: string): ArchiveObjectEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ArchiveContractError('archive_object_envelope_invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ArchiveContractError('archive_object_envelope_invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (
    (record.objectClass !== 'chunk' && record.objectClass !== 'manifest') ||
    typeof record.objectKey !== 'string' ||
    typeof record.orgId !== 'string' ||
    typeof record.keyVersion !== 'number' ||
    !Number.isSafeInteger(record.keyVersion) ||
    record.keyVersion < 1
  ) {
    throw new ArchiveContractError('archive_object_envelope_invalid');
  }
  return parsed as ArchiveObjectEnvelope;
}

async function unwrapVersion(
  env: Pick<ArchiveApiEnv, 'ARCHIVE_KEY_WRAPPING_SECRET'>,
  orgId: string,
  keyVersion: number,
  wrappedKey: string,
): Promise<CryptoKey> {
  return unwrapArchiveEncryptionKey(
    parseArchiveWrappedKeyVersion(wrappedKey, { orgId, keyVersion }),
    { orgId, keyVersion, wrappingSecretBase64: env.ARCHIVE_KEY_WRAPPING_SECRET },
  );
}

async function readStoredObject(bucket: R2Bucket, objectKey: string): Promise<StoredObject | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  if (object.size > MAX_ENCRYPTED_OBJECT_BYTES) {
    throw new ArchiveContractError('archive_object_exceeds_rotation_limit');
  }
  return { body: await object.text(), etag: object.etag };
}

async function boundedDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CHUNK_BYTES) {
        value.fill(0);
        throw new ArchiveContractError('archive_chunk_exceeds_rotation_limit');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
    if (error instanceof ArchiveContractError) throw error;
    throw new ArchiveContractError('archive_object_content_invalid');
  }
  const plaintext = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    plaintext.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return plaintext;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function assertManifestContent(plaintext: Uint8Array, objectKey: string): void {
  if (plaintext.byteLength > MAX_MANIFEST_BYTES) {
    throw new ArchiveContractError('archive_manifest_page_too_large');
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext),
    );
  } catch {
    throw new ArchiveContractError('archive_object_content_invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArchiveContractError('archive_object_content_invalid');
  }
  const manifest = value as Record<string, unknown>;
  const source = /\/sessions\/(claude|codex)\//u.exec(objectKey)?.[1];
  if (
    !source ||
    manifest.archive_format_version !== ARCHIVE_FORMAT_VERSION ||
    manifest.chain_hash_version !== CHAIN_HASH_VERSION ||
    manifest.source !== source ||
    !Number.isSafeInteger(manifest.generation) ||
    !Number.isSafeInteger(manifest.element_count)
  ) {
    throw new ArchiveContractError('archive_object_content_invalid');
  }
}

async function verifyContentIdentity(
  objectKey: string,
  objectClass: ArchiveObjectClass,
  decrypted: Uint8Array,
): Promise<void> {
  const plaintext = objectClass === 'chunk' ? await boundedDecompress(decrypted) : decrypted;
  try {
    if (objectClass === 'manifest') assertManifestContent(plaintext, objectKey);
    const expectedDigest = /\/(?:chunks|manifests)\/([0-9a-f]{64})$/u.exec(objectKey)?.[1];
    if (!expectedDigest || (await sha256Hex(plaintext)) !== expectedDigest) {
      throw new ArchiveContractError('archive_object_identity_mismatch');
    }
  } finally {
    if (plaintext !== decrypted) plaintext.fill(0);
  }
}

async function decryptAndVerify(
  body: string,
  key: CryptoKey,
  input: {
    orgId: string;
    objectKey: string;
    objectClass: ArchiveObjectClass;
    keyVersion: number;
  },
): Promise<Uint8Array> {
  const decrypted = await decryptArchiveObject(parseEnvelope(body), { key, ...input });
  try {
    await verifyContentIdentity(input.objectKey, input.objectClass, decrypted);
    return decrypted;
  } catch (error) {
    decrypted.fill(0);
    throw error;
  }
}

export async function commitRotationReplacement(
  env: Pick<ArchiveApiEnv, 'ARCHIVE_STORAGE'>,
  storage: DurableObjectStorage,
  input: ArchiveKeyRotationFence & {
    objectKey: string;
    replacementBody: string;
    expectedEtag: string;
  },
): Promise<void> {
  assertRotationReplaceAllowed(storage, input);
  const result = await env.ARCHIVE_STORAGE.put(input.objectKey, input.replacementBody, {
    onlyIf: { etagMatches: input.expectedEtag },
    httpMetadata: { contentType: 'application/json' },
  });
  if (result === null) throw new ArchiveContractError('archive_key_rotation_conflict');
}

export async function reencryptArchiveObject(
  env: Pick<ArchiveApiEnv, 'ARCHIVE_STORAGE' | 'ARCHIVE_KEY_WRAPPING_SECRET'>,
  storage: DurableObjectStorage,
  input: ArchiveKeyRotationFence & {
    orgId: string;
    objectKey: string;
    objectClass: BudgetObjectClass;
    fromWrappedKey: string;
    toWrappedKey: string;
    injectFailure?: ArchiveKeyRotationFailureInjection;
  },
): Promise<'rotated' | 'already'> {
  const expectedClass = objectClassFromBudget(input.objectClass);
  const canonical = await readStoredObject(env.ARCHIVE_STORAGE, input.objectKey);
  if (!canonical) throw new ArchiveContractError('rotation_object_missing');
  const envelope = parseEnvelope(canonical.body);
  if (
    envelope.objectKey !== input.objectKey ||
    envelope.orgId !== input.orgId ||
    envelope.objectClass !== expectedClass
  ) {
    throw new ArchiveContractError('archive_object_envelope_invalid');
  }

  const toKey = await unwrapVersion(env, input.orgId, input.toVersion, input.toWrappedKey);
  if (envelope.keyVersion === input.toVersion) {
    const plaintext = await decryptAndVerify(canonical.body, toKey, {
      orgId: input.orgId,
      objectKey: input.objectKey,
      objectClass: expectedClass,
      keyVersion: input.toVersion,
    });
    plaintext.fill(0);
    assertRotationReplaceAllowed(storage, input);
    recordRotatedObject(
      storage,
      input.objectKey,
      input.toVersion,
      new TextEncoder().encode(canonical.body).byteLength,
    );
    await env.ARCHIVE_STORAGE.delete(rotationTempObjectKey(input.objectKey));
    return 'already';
  }
  if (envelope.keyVersion !== input.fromVersion) {
    throw new ArchiveContractError('archive_key_version_mismatch');
  }

  const fromKey = await unwrapVersion(env, input.orgId, input.fromVersion, input.fromWrappedKey);
  const plaintext = await decryptAndVerify(canonical.body, fromKey, {
    orgId: input.orgId,
    objectKey: input.objectKey,
    objectClass: expectedClass,
    keyVersion: input.fromVersion,
  });
  let replacementBody: string;
  try {
    replacementBody = JSON.stringify(
      await encryptArchiveObject(plaintext, {
        key: toKey,
        orgId: input.orgId,
        objectKey: input.objectKey,
        objectClass: expectedClass,
        keyVersion: input.toVersion,
      }),
    );
  } finally {
    plaintext.fill(0);
  }

  const tempKey = rotationTempObjectKey(input.objectKey);
  await env.ARCHIVE_STORAGE.put(tempKey, replacementBody, {
    httpMetadata: { contentType: 'application/json' },
  });
  const temp = await readStoredObject(env.ARCHIVE_STORAGE, tempKey);
  if (temp?.body !== replacementBody) {
    throw new ArchiveContractError('r2_object_verification_failed');
  }
  const verifiedTemp = await decryptAndVerify(temp.body, toKey, {
    orgId: input.orgId,
    objectKey: input.objectKey,
    objectClass: expectedClass,
    keyVersion: input.toVersion,
  });
  verifiedTemp.fill(0);
  if (input.injectFailure === 'before_replace') {
    throw new ArchiveContractError('rotation_failure_injected');
  }

  await commitRotationReplacement(env, storage, {
    ...input,
    replacementBody,
    expectedEtag: canonical.etag,
  });
  const replaced = await readStoredObject(env.ARCHIVE_STORAGE, input.objectKey);
  if (replaced?.body !== replacementBody) {
    throw new ArchiveContractError('r2_object_verification_failed');
  }
  const verifiedReplacement = await decryptAndVerify(replaced.body, toKey, {
    orgId: input.orgId,
    objectKey: input.objectKey,
    objectClass: expectedClass,
    keyVersion: input.toVersion,
  });
  verifiedReplacement.fill(0);
  if (input.injectFailure === 'after_replace') {
    throw new ArchiveContractError('rotation_failure_injected');
  }

  assertRotationReplaceAllowed(storage, input);
  recordRotatedObject(
    storage,
    input.objectKey,
    input.toVersion,
    new TextEncoder().encode(replacementBody).byteLength,
  );
  await env.ARCHIVE_STORAGE.delete(tempKey);
  return 'rotated';
}
