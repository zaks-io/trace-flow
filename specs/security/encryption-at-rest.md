# Encrypt Request Bodies at Rest

## Overview

Request and response bodies are currently stored unencrypted in Cloudflare R2. These bodies may contain sensitive information (API keys, PII, credentials). Implement encryption before storage.

## Current Architecture

**Storage flow** (`workers/proxy/src/storage.ts`):

```
Client Request -> Proxy Worker -> R2 Bucket
                     |
              Plain text storage at:
              - requests/{requestId}
              - responses/{requestId}
```

**Retrieval flow** (`workers/api/src/index.ts`):

```
Dashboard -> API Worker -> R2 Bucket -> Plain text response
```

## Implementation Approach

Use **AES-256-GCM** encryption with the Web Crypto API (available in Cloudflare Workers).

### Key Management

Store encryption keys in Cloudflare Workers secrets:

```bash
wrangler secret put ENCRYPTION_KEY --env production
# Generate: openssl rand -base64 32
```

For key rotation support, maintain a key ID:

```typescript
interface EncryptedPayload {
  v: 1; // Version for future format changes
  kid: string; // Key ID for rotation
  iv: string; // Base64 initialization vector
  data: string; // Base64 ciphertext
  tag: string; // Base64 auth tag
}
```

### Encryption Module

**File**: `workers/proxy/src/crypto.ts`

```typescript
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;

interface EncryptionEnv {
  ENCRYPTION_KEY: string; // Base64 encoded
  ENCRYPTION_KEY_ID?: string; // For rotation, defaults to 'v1'
}

export async function encrypt(plaintext: string, env: EncryptionEnv): Promise<string> {
  const keyData = Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);

  const payload: EncryptedPayload = {
    v: 1,
    kid: env.ENCRYPTION_KEY_ID ?? 'v1',
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };

  return JSON.stringify(payload);
}

export async function decrypt(encrypted: string, env: EncryptionEnv): Promise<string> {
  const payload: EncryptedPayload = JSON.parse(encrypted);

  // In future, look up key by payload.kid for rotation support
  const keyData = Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['decrypt'],
  );

  const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);

  return new TextDecoder().decode(decrypted);
}
```

### Update Storage Module

**File**: `workers/proxy/src/storage.ts`

```typescript
import { encrypt } from './crypto';

export async function storeRequestResponse(
  storage: R2Bucket,
  requestId: string,
  requestBody: string,
  responseBody: string,
  env: EncryptionEnv,
): Promise<{ requestBodyKey: string; responseBodyKey: string; stored: boolean }> {
  const requestBodyKey = `requests/${requestId}`;
  const responseBodyKey = `responses/${requestId}`;

  try {
    // Encrypt before storing
    const [encryptedRequest, encryptedResponse] = await Promise.all([
      encrypt(requestBody, env),
      encrypt(responseBody, env),
    ]);

    await Promise.all([
      storage.put(requestBodyKey, encryptedRequest),
      storage.put(responseBodyKey, encryptedResponse),
    ]);

    return { requestBodyKey, responseBodyKey, stored: true };
  } catch (error) {
    console.error('Failed to store in R2:', { requestId, error });
    return { requestBodyKey, responseBodyKey, stored: false };
  }
}
```

### Update API Worker

**File**: `workers/api/src/index.ts`

```typescript
import { decrypt } from '../../proxy/src/crypto';

async function getRequestBody(requestId: string, env: Env): Promise<string | null> {
  const key = `requests/${requestId}`;
  const object = await env.STORAGE.get(key);

  if (!object) return null;

  const encrypted = await object.text();

  // Handle both encrypted and legacy unencrypted data
  try {
    const parsed = JSON.parse(encrypted);
    if (parsed.v === 1 && parsed.kid) {
      return decrypt(encrypted, env);
    }
  } catch {
    // Not JSON, assume legacy unencrypted
  }

  return encrypted; // Legacy fallback
}
```

## Migration Strategy

### Option A: Encrypt on Read (Lazy Migration)

Leave existing data unencrypted. New data is encrypted. Reads handle both formats (see API worker code above).

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

Future enhancement for key rotation:

1. Generate new key, assign new key ID
2. Add both keys to Workers secrets (keyed by ID)
3. New writes use new key ID
4. Reads look up key by ID from payload
5. After TTL, old key can be removed

## Performance Considerations

- AES-GCM is hardware-accelerated on modern CPUs
- Encryption adds ~1-2ms per operation (negligible for typical body sizes)
- Memory: Encryption processes full body in memory (existing behavior)
- Large bodies (>10MB): Consider streaming encryption (future enhancement)

## Testing

### Unit Tests

**File**: `workers/proxy/src/__tests__/crypto.test.ts`

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
- [ ] Encryption key stored as Worker secret
- [ ] Unit tests for encrypt/decrypt
- [ ] Integration test verifying encrypted storage
- [ ] Documentation updated with security note
