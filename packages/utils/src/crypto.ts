import type { EncryptedStoredBodiesPayload } from '@trace-flow/types';

const AES_ALGORITHM = 'AES-GCM';
const KDF_ALGORITHM = 'HKDF';
const KDF_HASH = 'SHA-256';
const ENCRYPTION_VERSION = 1;
const DEFAULT_KEY_ID = 'v1';
const ROOT_KEY_BYTES = 32;
const IV_BYTES = 12;

interface BodyEncryptionOptions {
  rootKeyBase64: string;
  orgId: string;
  objectKey: string;
  keyId?: string;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function decodeRootKey(rootKeyBase64: string): Uint8Array {
  let keyBytes: Uint8Array;

  try {
    keyBytes = decodeBase64(rootKeyBase64);
  } catch {
    throw new Error('Body encryption root key must be valid base64');
  }

  if (keyBytes.byteLength !== ROOT_KEY_BYTES) {
    throw new Error('Body encryption root key must decode to 32 bytes');
  }

  return keyBytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function buildAad(
  payload: Pick<EncryptedStoredBodiesPayload, 'v' | 'alg' | 'kdf' | 'kid' | 'orgId'>,
  objectKey: string,
): ArrayBuffer {
  return toArrayBuffer(
    new TextEncoder().encode(
      `trace-flow:r2-bodies:v${payload.v}:${payload.alg}:${payload.kdf}:${payload.kid}:${payload.orgId}:${objectKey}`,
    ),
  );
}

async function deriveBodyKey(options: Required<BodyEncryptionOptions>): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(decodeRootKey(options.rootKeyBase64)),
    KDF_ALGORITHM,
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: KDF_ALGORITHM,
      hash: KDF_HASH,
      salt: new TextEncoder().encode(options.keyId),
      info: new TextEncoder().encode(`trace-flow:r2-body:${options.orgId}`),
    },
    keyMaterial,
    { name: AES_ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptStoredBodyPayload(
  plaintext: string,
  options: BodyEncryptionOptions,
): Promise<EncryptedStoredBodiesPayload> {
  const keyId = options.keyId ?? DEFAULT_KEY_ID;
  const key = await deriveBodyKey({ ...options, keyId });
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: AES_ALGORITHM,
      iv: toArrayBuffer(iv),
      additionalData: buildAad(
        {
          v: ENCRYPTION_VERSION,
          alg: 'AES-GCM',
          kdf: 'HKDF-SHA-256',
          kid: keyId,
          orgId: options.orgId,
        },
        options.objectKey,
      ),
    },
    key,
    toArrayBuffer(new TextEncoder().encode(plaintext)),
  );

  return {
    v: ENCRYPTION_VERSION,
    alg: 'AES-GCM',
    kdf: 'HKDF-SHA-256',
    kid: keyId,
    orgId: options.orgId,
    iv: encodeBase64(iv),
    data: encodeBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptStoredBodyPayload(
  payload: EncryptedStoredBodiesPayload,
  options: BodyEncryptionOptions,
): Promise<string> {
  if (payload.orgId !== options.orgId) {
    throw new Error('Encrypted body org does not match expected org');
  }

  const key = await deriveBodyKey({ ...options, keyId: payload.kid });
  const plaintext = await crypto.subtle.decrypt(
    {
      name: AES_ALGORITHM,
      iv: toArrayBuffer(decodeBase64(payload.iv)),
      additionalData: buildAad(payload, options.objectKey),
    },
    key,
    toArrayBuffer(decodeBase64(payload.data)),
  );

  return new TextDecoder().decode(plaintext);
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function djb2Hash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}
