const ARCHIVE_CRYPTO_VERSION = 1 as const;
const ARCHIVE_ALGORITHM = 'AES-GCM' as const;
const ARCHIVE_KEY_BYTES = 32;
const ARCHIVE_NONCE_BYTES = 12;
const ARCHIVE_AUTH_TAG_BYTES = 16;
const ARCHIVE_WRAPPED_KEY_CIPHERTEXT_BYTES = ARCHIVE_KEY_BYTES + ARCHIVE_AUTH_TAG_BYTES;

export const ARCHIVE_KEY_WRAPPING_SECRET_BINDING = 'ARCHIVE_KEY_WRAPPING_SECRET' as const;

export type ArchiveObjectClass = 'chunk' | 'manifest';

export interface ArchiveWrappedKeyVersion {
  v: typeof ARCHIVE_CRYPTO_VERSION;
  alg: typeof ARCHIVE_ALGORITHM;
  orgId: string;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
}

export interface ArchiveObjectEnvelope {
  v: typeof ARCHIVE_CRYPTO_VERSION;
  alg: typeof ARCHIVE_ALGORITHM;
  orgId: string;
  objectKey: string;
  objectClass: ArchiveObjectClass;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
}

interface ArchiveMetadata {
  orgId: string;
  keyVersion: number;
}

interface ArchiveObjectMetadata extends ArchiveMetadata {
  objectKey: string;
  objectClass: ArchiveObjectClass;
}

interface ArchiveWrappingOptions {
  wrappingSecretBase64: string;
}

interface ArchiveKeyVersionOptions extends ArchiveWrappingOptions, ArchiveMetadata {}

interface ArchiveObjectEncryptionOptions extends ArchiveObjectMetadata {
  key: CryptoKey;
}

const ARCHIVE_CRYPTO_ERROR = 'Archive cryptographic operation failed';

function fail(): never {
  throw new Error(ARCHIVE_CRYPTO_ERROR);
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) fail();

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    if (encodeBase64(bytes) !== value) fail();
    return bytes;
  } catch {
    fail();
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function validateText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail();
}

function validateKeyVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail();
}

function validateMetadata(metadata: ArchiveMetadata): void {
  validateText(metadata.orgId);
  validateKeyVersion(metadata.keyVersion);
}

function validateObjectMetadata(metadata: ArchiveObjectMetadata): void {
  validateMetadata(metadata);
  validateText(metadata.objectKey);
  if (metadata.objectClass !== 'chunk' && metadata.objectClass !== 'manifest') fail();
}

function validateExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actualKeys = Object.keys(record);
  if (
    actualKeys.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    fail();
  }
}

function encodeCanonicalFields(domain: string, fields: readonly string[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const encoded = [domain, ...fields].map((field) => encoder.encode(field));
  const totalLength = encoded.reduce((total, field) => total + 4 + field.byteLength, 0);
  const result = new Uint8Array(totalLength);
  const view = new DataView(result.buffer);
  let offset = 0;

  for (const field of encoded) {
    view.setUint32(offset, field.byteLength);
    offset += 4;
    result.set(field, offset);
    offset += field.byteLength;
  }

  return toArrayBuffer(result);
}

function archiveKeyWrappingAad(metadata: ArchiveMetadata): ArrayBuffer {
  return encodeCanonicalFields('trace-flow:conversation-archive:key-wrap:v1', [
    metadata.orgId,
    String(metadata.keyVersion),
  ]);
}

function archiveObjectAad(metadata: ArchiveObjectMetadata): ArrayBuffer {
  return encodeCanonicalFields('trace-flow:conversation-archive:object:v1', [
    metadata.orgId,
    metadata.objectKey,
    metadata.objectClass,
    String(metadata.keyVersion),
  ]);
}

async function importWrappingKey(options: ArchiveWrappingOptions): Promise<CryptoKey> {
  const secret = decodeBase64(options.wrappingSecretBase64);
  if (secret.byteLength !== ARCHIVE_KEY_BYTES) fail();

  try {
    return await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(secret),
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

function validateWrappedKey(value: unknown): asserts value is ArchiveWrappedKeyVersion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  validateExactKeys(record, ['v', 'alg', 'orgId', 'keyVersion', 'nonce', 'ciphertext']);
  if (record.v !== ARCHIVE_CRYPTO_VERSION || record.alg !== ARCHIVE_ALGORITHM) fail();
  validateText(record.orgId);
  validateKeyVersion(record.keyVersion);
  const nonce = decodeBase64(record.nonce);
  if (nonce.byteLength !== ARCHIVE_NONCE_BYTES) fail();
  const ciphertext = decodeBase64(record.ciphertext);
  if (ciphertext.byteLength !== ARCHIVE_WRAPPED_KEY_CIPHERTEXT_BYTES) fail();
}

export function serializeArchiveWrappedKeyVersion(wrappedKey: ArchiveWrappedKeyVersion): string {
  validateWrappedKey(wrappedKey);
  return JSON.stringify(wrappedKey);
}

export function parseArchiveWrappedKeyVersion(
  serialized: string,
  expected: Pick<ArchiveWrappedKeyVersion, 'orgId' | 'keyVersion'>,
): ArchiveWrappedKeyVersion {
  try {
    validateMetadata(expected);
    if (typeof serialized !== 'string' || serialized.length === 0) fail();
    const parsed: unknown = JSON.parse(serialized);
    validateWrappedKey(parsed);
    if (parsed.orgId !== expected.orgId || parsed.keyVersion !== expected.keyVersion) fail();
    if (JSON.stringify(parsed) !== serialized) fail();
    return parsed;
  } catch {
    fail();
  }
}

function validateEnvelope(value: unknown): asserts value is ArchiveObjectEnvelope {
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
  const nonce = decodeBase64(record.nonce);
  if (nonce.byteLength !== ARCHIVE_NONCE_BYTES) fail();
  const ciphertext = decodeBase64(record.ciphertext);
  if (ciphertext.byteLength < ARCHIVE_AUTH_TAG_BYTES) fail();
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
          iv: toArrayBuffer(nonce),
          additionalData: archiveKeyWrappingAad(options),
        },
        wrappingKey,
        toArrayBuffer(rawKey),
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
    validateWrappedKey(wrappedKey);
    validateMetadata(options);
    if (wrappedKey.orgId !== options.orgId || wrappedKey.keyVersion !== options.keyVersion) fail();

    const wrappingKey = await importWrappingKey(options);
    const nonce = decodeBase64(wrappedKey.nonce);
    const ciphertext = decodeBase64(wrappedKey.ciphertext);
    const rawKey = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ARCHIVE_ALGORITHM,
          iv: toArrayBuffer(nonce),
          additionalData: archiveKeyWrappingAad(options),
        },
        wrappingKey,
        toArrayBuffer(ciphertext),
      ),
    );

    try {
      if (rawKey.byteLength !== ARCHIVE_KEY_BYTES) fail();
      return await crypto.subtle.importKey(
        'raw',
        toArrayBuffer(rawKey),
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
        iv: toArrayBuffer(nonce),
        additionalData: archiveObjectAad(options),
      },
      options.key,
      toArrayBuffer(plaintext),
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
    validateEnvelope(envelope);
    validateObjectMetadata(options);
    if (
      envelope.orgId !== options.orgId ||
      envelope.objectKey !== options.objectKey ||
      envelope.objectClass !== options.objectClass ||
      envelope.keyVersion !== options.keyVersion
    ) {
      fail();
    }

    const nonce = decodeBase64(envelope.nonce);
    const ciphertext = decodeBase64(envelope.ciphertext);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ARCHIVE_ALGORITHM,
          iv: toArrayBuffer(nonce),
          additionalData: archiveObjectAad(options),
        },
        options.key,
        toArrayBuffer(ciphertext),
      ),
    );
  } catch {
    fail();
  }
}
