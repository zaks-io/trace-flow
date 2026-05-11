# Encrypt Request Bodies at Rest

## Overview

Request and response bodies are currently stored unencrypted in Cloudflare R2. These bodies may contain sensitive information (API keys, PII, credentials). Implement encryption before storage.

## Current Architecture

**Storage flow** (`apps/proxy/src/storage.ts`):

```
Client Request -> Proxy Worker -> R2 Bucket
                     |
              Plain text storage at:
              - bodies/{requestId}
```

**Retrieval flow** (`apps/api/src/index.ts`):

```
Dashboard -> API Worker -> R2 Bucket -> Plain text response
```

## Implementation Approach

Use tenant-scoped **AES-256-GCM** encryption with the Web Crypto API (available in Cloudflare Workers). Body payloads are encrypted with an org-specific key derived from a shared root secret, so encryption is scoped to the owning organization.

### Key Management

Store the root encryption key in Cloudflare Workers secrets on both the proxy and API workers:

```bash
wrangler secret put BODY_ENCRYPTION_ROOT_KEY --env production
# Generate: openssl rand -base64 32
```

Set `BODY_ENCRYPTION_KEY_ID` for rotation support and include org context in the encrypted envelope:

```typescript
interface EncryptedPayload {
  v: 1; // Version for future format changes
  alg: 'AES-GCM';
  kdf: 'HKDF-SHA-256';
  kid: string; // Key ID for rotation
  orgId: string; // Owning organization
  iv: string; // Base64 initialization vector
  data: string; // Base64 ciphertext
}
```

Workers derive an org-scoped AES key using HKDF-SHA-256 from `BODY_ENCRYPTION_ROOT_KEY`, `BODY_ENCRYPTION_KEY_ID`, and `orgId`. HKDF uses a fixed zero salt because the root key provides the entropy; `orgId` and `keyId` are included in `info` as domain/context binding. AES-GCM additional authenticated data includes the envelope version, algorithm, KDF, key ID, `orgId`, and R2 object key so encrypted bodies cannot be replayed across organizations, key versions, or object keys.

### Encryption Module

**File**: `packages/utils/src/crypto.ts`

```typescript
interface BodyEncryptionOptions {
  rootKeyBase64: string; // Base64 encoded 32-byte root key
  orgId: string;
  objectKey: string;
  keyId?: string; // For rotation, defaults to 'v1'
}

export async function encryptStoredBodyPayload(
  plaintext: string,
  options: BodyEncryptionOptions,
): Promise<EncryptedPayload>;

export async function decryptStoredBodyPayload(
  payload: EncryptedPayload,
  options: BodyEncryptionOptions,
): Promise<string>;
```

### Update Storage Module

**File**: `apps/proxy/src/storage.ts`

```typescript
const payload = JSON.stringify({ requestBody, responseBody, truncated });
const encryptedPayload = await encryptStoredBodyPayload(payload, {
  rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY,
  keyId: env.BODY_ENCRYPTION_KEY_ID,
  orgId,
  objectKey: bodyKey,
});

await storage.put(bodyKey, JSON.stringify(encryptedPayload), {
  customMetadata: { orgId },
  httpMetadata: { contentType: 'application/json' },
});
```

### Update API Worker

**File**: `apps/api/src/index.ts`

```typescript
async function getStoredBodies(requestId: string, env: Env): Promise<StoredBodiesPayload | null> {
  const key = `bodies/${requestId}`;
  const object = await env.STORAGE.get(key);

  if (!object) return null;

  const raw = await object.text();
  const parsed = JSON.parse(raw);

  if (isEncryptedStoredBodiesPayload(parsed)) {
    const orgId = object.customMetadata?.orgId;
    if (parsed.orgId !== orgId) {
      throw new Error('Organization metadata mismatch');
    }
    const decrypted = await decryptStoredBodyPayload(parsed, {
      rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY,
      keyId: env.BODY_ENCRYPTION_KEY_ID,
      orgId,
      objectKey: key,
    });
    return parseStoredBodiesPayload(decrypted);
  }

  // Legacy plaintext fallback is logged and can be removed after the R2 TTL window.
  return parseStoredBodiesPayload(raw);
}
```

## Migration Strategy

### Option A: Encrypt on Read (Lazy Migration)

Leave existing data unencrypted. New data is encrypted. Reads handle both formats (see API worker code above), but encrypted reads require matching R2 org metadata and envelope org ID.

**Pros**: No downtime, simple
**Cons**: Old data remains unencrypted until TTL expires

### Option B: Background Migration

Run a migration script to encrypt existing data in place:

```typescript
// scripts/migrate-encryption.ts
async function migrateR2Object(bucket: R2Bucket, key: string, env: EncryptionEnv) {
  const object = await bucket.get(key);
  if (!object) return;

  const plaintext = await object.text();

  // Skip if already encrypted
  try {
    const parsed = JSON.parse(plaintext);
    if (parsed.v === 1) return;
  } catch {}

  const encrypted = await encrypt(plaintext, env);
  await bucket.put(key, encrypted);
}
```

**Recommended**: Option A for simplicity. R2 data has 90-day TTL, so unencrypted data naturally ages out.

## Key Rotation

`BODY_ENCRYPTION_KEY_ID` can be rotated without downtime as long as the root key remains the same:

1. Assign a new key ID
2. New writes use the new key ID for HKDF derivation and record it as `kid` in the envelope
3. Reads use `kid` from the payload, not the currently configured write key ID, to derive the matching tenant key from the same root
4. After TTL, old key IDs no longer appear in stored envelopes

Rotating `BODY_ENCRYPTION_ROOT_KEY` itself is a flag-day operation with the current single-root configuration. Existing encrypted objects cannot be decrypted with a new root key, even when their original `kid` is present, until a future multi-root key lookup is implemented. If the root key must be replaced, expect old encrypted objects to fail decryption until they expire via R2 TTL.

## Performance Considerations

- AES-GCM is hardware-accelerated on modern CPUs
- Encryption adds ~1-2ms per operation (negligible for typical body sizes)
- Memory: Encryption processes full body in memory (existing behavior)
- Large bodies (>10MB): Consider streaming encryption (future enhancement)

## Testing

### Unit Tests

**File**: `apps/proxy/src/__tests__/crypto.test.ts`

```typescript
describe('Encryption', () => {
  const env = { ENCRYPTION_KEY: btoa(crypto.getRandomValues(new Uint8Array(32))) };

  it('encrypts and decrypts round-trip', async () => {
    const plaintext = 'sensitive data';
    const encrypted = await encrypt(plaintext, env);
    const decrypted = await decrypt(encrypted, env);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same input (unique IV)', async () => {
    const plaintext = 'test';
    const e1 = await encrypt(plaintext, env);
    const e2 = await encrypt(plaintext, env);
    expect(e1).not.toBe(e2);
  });

  it('handles unicode and special characters', async () => {
    const plaintext = '{"message": "Hello world"}';
    const encrypted = await encrypt(plaintext, env);
    const decrypted = await decrypt(encrypted, env);
    expect(decrypted).toBe(plaintext);
  });
});
```

## Acceptance Criteria

- [ ] New request/response bodies stored encrypted in R2
- [ ] API worker decrypts bodies for display
- [ ] Backward compatible with existing unencrypted data
- [ ] Root encryption key stored as Worker secret on proxy and API
- [ ] Org ID is included in key derivation and AES-GCM authenticated data
- [ ] Unit tests for encrypt/decrypt
- [ ] Integration test verifying encrypted storage
- [ ] Documentation updated with security note
