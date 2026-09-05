import { decryptArchiveObject, type ArchiveObjectEnvelope } from '@trace-flow/utils';
import { ArchiveContractError } from './archive-contract';
import { decompress } from './archive-packing';
import type { StorageBudgetObject } from './archive-storage-budget';

export interface ArchiveR2Object {
  key: string;
  body: string;
  objectClass: 'chunk' | 'manifest';
}

export function storageBudgetObject(object: ArchiveR2Object): StorageBudgetObject {
  return {
    objectKey: object.key,
    objectClass: object.objectClass === 'chunk' ? 'agent_archive_chunk' : 'agent_archive_manifest',
    bytes: new TextEncoder().encode(object.body).byteLength,
    expiresAt: null,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index++) {
    different |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return different === 0;
}

async function readExact(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

export async function verifyOrPutImmutableObject(
  bucket: R2Bucket,
  object: ArchiveR2Object,
): Promise<void> {
  const expected = new TextEncoder().encode(object.body);
  const existing = await readExact(bucket, object.key);
  if (existing) {
    if (!equalBytes(existing, expected)) {
      throw new ArchiveContractError('immutable_object_collision');
    }
    return;
  }
  await bucket.put(object.key, object.body, {
    httpMetadata: { contentType: 'application/json' },
  });
  const verified = await readExact(bucket, object.key);
  if (!verified || !equalBytes(verified, expected)) {
    throw new ArchiveContractError('r2_object_verification_failed');
  }
}

async function verifyEncryptedChunk(
  object: ArchiveR2Object,
  key: CryptoKey,
  orgId: string,
  keyVersion: number,
  expectedPlaintext: Uint8Array,
): Promise<void> {
  const envelope = JSON.parse(object.body) as ArchiveObjectEnvelope;
  const compressed = await decryptArchiveObject(envelope, {
    key,
    orgId,
    objectKey: object.key,
    objectClass: 'chunk',
    keyVersion,
  });
  const plaintext = await decompress(compressed);
  if (!equalBytes(plaintext, expectedPlaintext)) {
    throw new ArchiveContractError('compressed_chunk_verification_failed');
  }
}

async function verifyEncryptedManifest(
  object: ArchiveR2Object,
  key: CryptoKey,
  orgId: string,
  keyVersion: number,
  expectedPlaintext: Uint8Array,
): Promise<void> {
  const envelope = JSON.parse(object.body) as ArchiveObjectEnvelope;
  const plaintext = await decryptArchiveObject(envelope, {
    key,
    orgId,
    objectKey: object.key,
    objectClass: 'manifest',
    keyVersion,
  });
  if (!equalBytes(plaintext, expectedPlaintext)) {
    throw new ArchiveContractError('manifest_encryption_verification_failed');
  }
}

export async function verifyEncryptedPlannedObject(
  object: ArchiveR2Object,
  key: CryptoKey,
  orgId: string,
  keyVersion: number,
  expectedPlaintext: Uint8Array,
): Promise<void> {
  if (object.objectClass === 'chunk') {
    await verifyEncryptedChunk(object, key, orgId, keyVersion, expectedPlaintext);
  } else {
    await verifyEncryptedManifest(object, key, orgId, keyVersion, expectedPlaintext);
  }
}
