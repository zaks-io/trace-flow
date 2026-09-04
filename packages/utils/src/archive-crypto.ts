import {
  ARCHIVE_ALGORITHM,
  ARCHIVE_AUTH_TAG_BYTES,
  ARCHIVE_CRYPTO_VERSION,
  ARCHIVE_KEY_BYTES,
  ARCHIVE_NONCE_BYTES,
  ARCHIVE_WRAPPED_KEY_CIPHERTEXT_BYTES,
  archiveKeyWrappingAad,
  archiveObjectAad,
  asCryptoBuffer,
  decodeBase64,
  encodeBase64,
  fail,
  validateExactKeys,
  validateKeyVersion,
  validateMetadata,
  validateObjectMetadata,
  validateText,
} from './archive-crypto-primitives';
import type {
  ArchiveKeyVersionOptions,
  ArchiveObjectEncryptionOptions,
  ArchiveObjectEnvelope,
  ArchiveMetadata,
  ArchiveWrappingOptions,
  ArchiveWrappedKeyVersion,
  DecodedArchiveObjectEnvelope,
  DecodedArchiveWrappedKeyVersion,
} from './archive-crypto-primitives';

export { ARCHIVE_KEY_WRAPPING_SECRET_BINDING } from './archive-crypto-primitives';
export type {
  ArchiveObjectClass,
  ArchiveObjectEnvelope,
  ArchiveWrappedKeyVersion,
} from './archive-crypto-primitives';

async function importWrappingKey(options: ArchiveWrappingOptions): Promise<CryptoKey> {
  const secret = decodeBase64(options.wrappingSecretBase64);
  if (secret.byteLength !== ARCHIVE_KEY_BYTES) fail();

  try {
    return await crypto.subtle.importKey(
      'raw',
      asCryptoBuffer(secret),
      { name: ARCHIVE_ALGORITHM },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    fail();
  } finally {
    secret.fill(0);
  }
}

function decodeWrappedKey(value: unknown): DecodedArchiveWrappedKeyVersion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  validateExactKeys(record, ['v', 'alg', 'orgId', 'keyVersion', 'nonce', 'ciphertext']);
  if (record.v !== ARCHIVE_CRYPTO_VERSION || record.alg !== ARCHIVE_ALGORITHM) fail();
  validateText(record.orgId);
  validateKeyVersion(record.keyVersion);
  if (typeof record.nonce !== 'string' || typeof record.ciphertext !== 'string') fail();
  const nonceBytes = decodeBase64(record.nonce);
  if (nonceBytes.byteLength !== ARCHIVE_NONCE_BYTES) fail();
  const ciphertextBytes = decodeBase64(record.ciphertext);
  if (ciphertextBytes.byteLength !== ARCHIVE_WRAPPED_KEY_CIPHERTEXT_BYTES) fail();

  return {
    record: {
      v: ARCHIVE_CRYPTO_VERSION,
      alg: ARCHIVE_ALGORITHM,
      orgId: record.orgId,
      keyVersion: record.keyVersion,
      nonce: record.nonce,
      ciphertext: record.ciphertext,
    },
    nonceBytes,
    ciphertextBytes,
  };
}

export function serializeArchiveWrappedKeyVersion(wrappedKey: ArchiveWrappedKeyVersion): string {
  return JSON.stringify(decodeWrappedKey(wrappedKey).record);
}

export function parseArchiveWrappedKeyVersion(
  serialized: string,
  expected: Pick<ArchiveWrappedKeyVersion, 'orgId' | 'keyVersion'>,
): ArchiveWrappedKeyVersion {
  try {
    validateMetadata(expected);
    if (typeof serialized !== 'string' || serialized.length === 0) fail();
    const parsed: unknown = JSON.parse(serialized);
    const decoded = decodeWrappedKey(parsed);
    if (
      decoded.record.orgId !== expected.orgId ||
      decoded.record.keyVersion !== expected.keyVersion
    ) {
      fail();
    }
    if (JSON.stringify(decoded.record) !== serialized) fail();
    return decoded.record;
  } catch {
    fail();
  }
}

function decodeEnvelope(value: unknown): DecodedArchiveObjectEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  validateExactKeys(record, [
    'v',
    'alg',
    'orgId',
    'objectKey',
    'objectClass',
    'keyVersion',
    'nonce',
    'ciphertext',
  ]);
  if (record.v !== ARCHIVE_CRYPTO_VERSION || record.alg !== ARCHIVE_ALGORITHM) fail();
  validateText(record.orgId);
  validateText(record.objectKey);
  if (record.objectClass !== 'chunk' && record.objectClass !== 'manifest') fail();
  validateKeyVersion(record.keyVersion);
  if (typeof record.nonce !== 'string' || typeof record.ciphertext !== 'string') fail();
  const nonceBytes = decodeBase64(record.nonce);
  if (nonceBytes.byteLength !== ARCHIVE_NONCE_BYTES) fail();
  const ciphertextBytes = decodeBase64(record.ciphertext);
  if (ciphertextBytes.byteLength < ARCHIVE_AUTH_TAG_BYTES) fail();

  return {
    record: {
      v: ARCHIVE_CRYPTO_VERSION,
      alg: ARCHIVE_ALGORITHM,
      orgId: record.orgId,
      objectKey: record.objectKey,
      objectClass: record.objectClass,
      keyVersion: record.keyVersion,
      nonce: record.nonce,
      ciphertext: record.ciphertext,
    },
    nonceBytes,
    ciphertextBytes,
  };
}

export async function createArchiveEncryptionKeyVersion(
  options: ArchiveKeyVersionOptions,
): Promise<ArchiveWrappedKeyVersion> {
  try {
    validateMetadata(options);
    const wrappingKey = await importWrappingKey(options);
    const rawKey = crypto.getRandomValues(new Uint8Array(ARCHIVE_KEY_BYTES));
    const nonce = crypto.getRandomValues(new Uint8Array(ARCHIVE_NONCE_BYTES));

    try {
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: ARCHIVE_ALGORITHM,
          iv: asCryptoBuffer(nonce),
          additionalData: archiveKeyWrappingAad(options),
        },
        wrappingKey,
        asCryptoBuffer(rawKey),
      );

      return {
        v: ARCHIVE_CRYPTO_VERSION,
        alg: ARCHIVE_ALGORITHM,
        orgId: options.orgId,
        keyVersion: options.keyVersion,
        nonce: encodeBase64(nonce),
        ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      };
    } finally {
      rawKey.fill(0);
    }
  } catch {
    fail();
  }
}

export async function unwrapArchiveEncryptionKey(
  wrappedKey: ArchiveWrappedKeyVersion,
  options: ArchiveWrappingOptions & ArchiveMetadata,
): Promise<CryptoKey> {
  try {
    const decoded = decodeWrappedKey(wrappedKey);
    validateMetadata(options);
    if (
      decoded.record.orgId !== options.orgId ||
      decoded.record.keyVersion !== options.keyVersion
    ) {
      fail();
    }

    const wrappingKey = await importWrappingKey(options);
    const rawKey = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ARCHIVE_ALGORITHM,
          iv: asCryptoBuffer(decoded.nonceBytes),
          additionalData: archiveKeyWrappingAad(options),
        },
        wrappingKey,
        asCryptoBuffer(decoded.ciphertextBytes),
      ),
    );

    try {
      if (rawKey.byteLength !== ARCHIVE_KEY_BYTES) fail();
      return await crypto.subtle.importKey(
        'raw',
        asCryptoBuffer(rawKey),
        { name: ARCHIVE_ALGORITHM },
        false,
        ['encrypt', 'decrypt'],
      );
    } finally {
      rawKey.fill(0);
    }
  } catch {
    fail();
  }
}

export async function encryptArchiveObject(
  plaintext: Uint8Array,
  options: ArchiveObjectEncryptionOptions,
): Promise<ArchiveObjectEnvelope> {
  try {
    validateObjectMetadata(options);
    const nonce = crypto.getRandomValues(new Uint8Array(ARCHIVE_NONCE_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: ARCHIVE_ALGORITHM,
        iv: asCryptoBuffer(nonce),
        additionalData: archiveObjectAad(options),
      },
      options.key,
      asCryptoBuffer(plaintext),
    );

    return {
      v: ARCHIVE_CRYPTO_VERSION,
      alg: ARCHIVE_ALGORITHM,
      orgId: options.orgId,
      objectKey: options.objectKey,
      objectClass: options.objectClass,
      keyVersion: options.keyVersion,
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    };
  } catch {
    fail();
  }
}

export async function decryptArchiveObject(
  envelope: ArchiveObjectEnvelope,
  options: ArchiveObjectEncryptionOptions,
): Promise<Uint8Array> {
  try {
    const decoded = decodeEnvelope(envelope);
    const record = decoded.record;
    validateObjectMetadata(options);
    if (
      record.orgId !== options.orgId ||
      record.objectKey !== options.objectKey ||
      record.objectClass !== options.objectClass ||
      record.keyVersion !== options.keyVersion
    ) {
      fail();
    }

    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ARCHIVE_ALGORITHM,
          iv: asCryptoBuffer(decoded.nonceBytes),
          additionalData: archiveObjectAad(options),
        },
        options.key,
        asCryptoBuffer(decoded.ciphertextBytes),
      ),
    );
  } catch {
    fail();
  }
}
