export const ARCHIVE_CRYPTO_VERSION = 1 as const;
export const ARCHIVE_ALGORITHM = 'AES-GCM' as const;
export const ARCHIVE_KEY_BYTES = 32;
export const ARCHIVE_NONCE_BYTES = 12;
export const ARCHIVE_AUTH_TAG_BYTES = 16;
export const ARCHIVE_WRAPPED_KEY_CIPHERTEXT_BYTES = ARCHIVE_KEY_BYTES + ARCHIVE_AUTH_TAG_BYTES;

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

export interface ArchiveMetadata {
  orgId: string;
  keyVersion: number;
}

export interface ArchiveObjectMetadata extends ArchiveMetadata {
  objectKey: string;
  objectClass: ArchiveObjectClass;
}

export interface ArchiveWrappingOptions {
  wrappingSecretBase64: string;
}

export interface ArchiveKeyVersionOptions extends ArchiveWrappingOptions, ArchiveMetadata {}

export interface ArchiveObjectEncryptionOptions extends ArchiveObjectMetadata {
  key: CryptoKey;
}

export interface DecodedArchiveWrappedKeyVersion {
  record: ArchiveWrappedKeyVersion;
  nonceBytes: Uint8Array;
  ciphertextBytes: Uint8Array;
}

export interface DecodedArchiveObjectEnvelope {
  record: ArchiveObjectEnvelope;
  nonceBytes: Uint8Array;
  ciphertextBytes: Uint8Array;
}

export const ARCHIVE_KEY_WRAPPING_SECRET_BINDING = 'ARCHIVE_KEY_WRAPPING_SECRET' as const;
const ARCHIVE_CRYPTO_ERROR = 'Archive cryptographic operation failed';

export function fail(): never {
  throw new Error(ARCHIVE_CRYPTO_ERROR);
}

export function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x7ffe;
  const encodedChunks: string[] = [];

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    const chars = new Array<string>(end - i);
    for (let index = i; index < end; index++) {
      chars[index - i] = String.fromCharCode(bytes[index]!);
    }
    encodedChunks.push(btoa(chars.join('')));
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

export function decodeBase64(value: unknown): Uint8Array {
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

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function asCryptoBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(bytes.buffer instanceof ArrayBuffer)) fail();
  return bytes as Uint8Array<ArrayBuffer>;
}

export function validateText(value: unknown): asserts value is string {
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

export function validateKeyVersion(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail();
}

export function validateMetadata(metadata: ArchiveMetadata): void {
  validateText(metadata.orgId);
  validateKeyVersion(metadata.keyVersion);
}

export function validateObjectMetadata(metadata: ArchiveObjectMetadata): void {
  validateMetadata(metadata);
  validateText(metadata.objectKey);
  if (metadata.objectClass !== 'chunk' && metadata.objectClass !== 'manifest') fail();
}

export function validateExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
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

export function archiveKeyWrappingAad(metadata: ArchiveMetadata): ArrayBuffer {
  return encodeCanonicalFields('trace-flow:conversation-archive:key-wrap:v1', [
    metadata.orgId,
    String(metadata.keyVersion),
  ]);
}

export function archiveObjectAad(metadata: ArchiveObjectMetadata): ArrayBuffer {
  return encodeCanonicalFields('trace-flow:conversation-archive:object:v1', [
    metadata.orgId,
    metadata.objectKey,
    metadata.objectClass,
    String(metadata.keyVersion),
  ]);
}
