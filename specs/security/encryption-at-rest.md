# Encryption At Rest

Trace Flow encrypts stored LLM request/response bodies before writing them to Cloudflare R2.
Conversation Archive is designed but not part of the current implementation.

## Current Body Storage Path

`apps/proxy/src/storage.ts` stores one encrypted R2 object per proxied LLM request:

```text
Client -> Proxy -> encrypted R2 object at bodies/{requestId}
```

The stored plaintext shape before encryption is:

```typescript
interface StoredBodiesPayload {
  requestBody: string | null;
  responseBody: string | null;
  truncated?: boolean;
}
```

The persisted object shape is `EncryptedStoredBodiesPayload` from `packages/types/src/storage.ts`:

```typescript
interface EncryptedStoredBodiesPayload {
  v: 1;
  alg: 'AES-GCM';
  kdf: 'HKDF-SHA-256';
  kid: string;
  orgId: string;
  iv: string;
  data: string;
}
```

R2 custom metadata stores `orgId` so the API Worker can enforce organization ownership before serving
the object.

## Encryption Design

Encryption lives in `packages/utils/src/crypto.ts`.

- algorithm: AES-256-GCM
- key derivation: HKDF-SHA-256
- root secret: `BODY_ENCRYPTION_ROOT_KEY`
- write key id: `BODY_ENCRYPTION_KEY_ID`, defaulting to `v1`
- key context: organization id and key id
- authenticated data: envelope metadata plus the R2 object key

The Proxy refuses to store body objects when the organization id or root encryption key is missing.
Storage failure does not block the client response; the request still streams and the queue message
can still be sent.

## Read Path

`apps/api/src/bodies.ts` reads `bodies/{requestId}` and:

1. parses the R2 object
2. verifies the encrypted envelope org matches R2 metadata
3. requires `BODY_ENCRYPTION_ROOT_KEY`
4. decrypts with the key id recorded in the envelope
5. parses the decrypted `StoredBodiesPayload`
6. applies organization membership and visibility-window checks before returning the body

The API Worker still logs and parses a legacy plaintext fallback for old objects. New Proxy writes are
encrypted.

## Key Rotation

Changing `BODY_ENCRYPTION_KEY_ID` rotates the HKDF context for new writes while allowing old objects
to decrypt because the envelope records `kid`.

Changing `BODY_ENCRYPTION_ROOT_KEY` is a breaking rotation with the current single-root design. Old
objects cannot be decrypted with a new root until a future multi-root lookup exists. Prefer key-id
rotation unless there is a root-key incident.

## Conversation Archive

Agent Conversation Analytics currently uploads typed facts only. The Rust sync envelope explicitly
omits `raw_session_bundles`, and Agent Ingest has no R2 binding for raw transcript storage.

The accepted target in [ADR 0012](../../docs/adr/0012-agent-conversation-analytics.md) has no generic or
90-day raw-upload mode. Only an explicitly activated Pro Conversation Archive and separately enrolled
Collector may upload lossless Archive JSONL. The target uses a dedicated Agent Archive R2 bucket and
independent, versioned, server-managed Archive Encryption Keys rather than the Body Object root key.
Archive Chunks, Archive Session Ledgers and manifests, key rotation, owner-only export grants, deletion,
and production smoke coverage must ship before the archive can be described as live.

## Tests

Current coverage lives in:

- `packages/utils/src/crypto.test.ts`
- `apps/proxy/src/__tests__/storage.test.ts`
- `apps/proxy/src/__tests__/index.test.ts`
- `apps/api/src/__tests__/bodies.test.ts`
