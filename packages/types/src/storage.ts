export interface StoredBodiesPayload {
  requestBody: string | null;
  responseBody: string | null;
  truncated?: boolean;
}

export interface EncryptedStoredBodiesPayload {
  v: 1;
  alg: 'AES-GCM';
  kdf: 'HKDF-SHA-256';
  kid: string;
  orgId: string;
  iv: string;
  data: string;
}

export function isEncryptedStoredBodiesPayload(
  value: unknown,
): value is EncryptedStoredBodiesPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.alg === 'AES-GCM' &&
    record.kdf === 'HKDF-SHA-256' &&
    typeof record.kid === 'string' &&
    typeof record.orgId === 'string' &&
    typeof record.iv === 'string' &&
    typeof record.data === 'string'
  );
}

export function buildStoredBodyKey(requestId: string): string {
  return `bodies/${requestId}`;
}
