import { decryptArchiveObject, type ArchiveObjectEnvelope } from '@trace-flow/utils';
import { ArchiveContractError } from './archive-contract';
import { decompress } from './archive-packing';
import type { StorageBudgetObject } from './archive-storage-budget';

export interface ArchiveR2Object {
  key: string;
  body: string;
  objectClass: 'chunk' | 'manifest';
}

export class ArchiveR2BatchWriteError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly definitelyUnwritten: ArchiveR2Object[],
  ) {
    super(cause instanceof Error ? cause.message : 'archive_object_write_failed');
    this.name = 'ArchiveR2BatchWriteError';
  }
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

function markWriteAttempt(error: unknown, writeAttempted: boolean): Error {
  const marked = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(marked, 'writeAttempted', {
    configurable: true,
    enumerable: false,
    value: writeAttempted,
  });
  return marked;
}

export function didAttemptWrite(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'writeAttempted' in error &&
    (error as { writeAttempted?: unknown }).writeAttempted === true
  );
}

export async function verifyOrPutImmutableObject(
  bucket: R2Bucket,
  object: ArchiveR2Object,
): Promise<void> {
  const expected = new TextEncoder().encode(object.body);
  let existing: Uint8Array | null;
  try {
    existing = await readExact(bucket, object.key);
  } catch (error) {
    throw markWriteAttempt(error, false);
  }
  if (existing) {
    if (!equalBytes(existing, expected)) {
      throw markWriteAttempt(new ArchiveContractError('immutable_object_collision'), false);
    }
    return;
  }
  try {
    await bucket.put(object.key, object.body, {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (error) {
    throw markWriteAttempt(error, true);
  }
  let verified: Uint8Array | null;
  try {
    verified = await readExact(bucket, object.key);
  } catch (error) {
    throw markWriteAttempt(error, true);
  }
  if (!verified || !equalBytes(verified, expected)) {
    throw markWriteAttempt(new ArchiveContractError('r2_object_verification_failed'), true);
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
