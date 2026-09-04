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

interface DecodedArchiveWrappedKeyVersion {
  record: ArchiveWrappedKeyVersion;
  nonceBytes: Uint8Array;
  ciphertextBytes: Uint8Array;
}

interface DecodedArchiveObjectEnvelope {
  record: ArchiveObjectEnvelope;
  nonceBytes: Uint8Array;
  ciphertextBytes: Uint8Array;
}

const ARCHIVE_CRYPTO_ERROR = 'Archive cryptographic operation failed';

function fail(): never {
  throw new Error(ARCHIVE_CRYPTO_ERROR);
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x7ffe;
  const encodedChunks: string[] = [];

  for (let i = 0; i < bytes.length; i += chunkSize) {
    encodedChunks.push(btoa(String.fromCharCode(...bytes.subarray(i, i + chunkSize))));
  }

  return encodedChunks.join('');
}

function base64Digit(codeUnit: number): number {
  if (codeUnit >= 0x41 && codeUnit <= 0x5a) return codeUnit - 0x41;
  if (codeUnit >= 0x61 && codeUnit <= 0x7a) return codeUnit - 0x47;
  if (codeUnit >= 0x30 && codeUnit <= 0x39) return codeUnit + 0x04;
  if (codeUnit === 0x2b) return 0x3e;
  if (codeUnit === 0x2f) return 0x3f;
  return -1;
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) fail();

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  const bytes = new Uint8Array(decodedLength);
  let outputOffset = 0;

  for (let inputOffset = 0; inputOffset < value.length; inputOffset += 4) {
    const a = base64Digit(value.charCodeAt(inputOffset));
    const b = base64Digit(value.charCodeAt(inputOffset + 1));
    const cCodeUnit = value.charCodeAt(inputOffset + 2);
    const dCodeUnit = value.charCodeAt(inputOffset + 3);
    const c = cCodeUnit === 0x3d ? -1 : base64Digit(cCodeUnit);
    const d = dCodeUnit === 0x3d ? -1 : base64Digit(dCodeUnit);
    const isFinalQuartet = inputOffset + 4 === value.length;

    if (a < 0 || b < 0) fail();
    bytes[outputOffset++] = (a << 2) | (b >> 4);

    if (c < 0) {
      if (!isFinalQuartet || cCodeUnit !== 0x3d || dCodeUnit !== 0x3d || (b & 0x0f) !== 0) {
        fail();
      }
      continue;
    }

    bytes[outputOffset++] = (b << 4) | (c >> 2);
    if (d < 0) {
      if (!isFinalQuartet || dCodeUnit !== 0x3d || (c & 0x03) !== 0) fail();
      continue;
    }

    bytes[outputOffset++] = (c << 6) | d;
  }

  if (outputOffset !== decodedLength) fail();
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function asCryptoBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(bytes.buffer instanceof ArrayBuffer)) fail();
  return bytes as Uint8Array<ArrayBuffer>;
}

function validateText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !isWellFormedString(value)) fail();
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
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
