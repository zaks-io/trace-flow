import { describe, expect, it } from 'vitest';
import {
  assertBodyEncryptionRootKey,
  decryptStoredBodyPayload,
  encryptStoredBodyPayload,
} from './crypto';

const ROOT_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const OTHER_ROOT_KEY = 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=';

const encryptionOptions = {
  rootKeyBase64: ROOT_KEY,
  orgId: 'org_123',
  objectKey: 'bodies/req_123',
};

describe('stored body encryption', () => {
  it('encrypts and decrypts a payload', async () => {
    const plaintext = JSON.stringify({
      requestBody: '{"prompt":"hi"}',
      responseBody: '{"output":"hello"}',
    });

    const encrypted = await encryptStoredBodyPayload(plaintext, encryptionOptions);
    const decrypted = await decryptStoredBodyPayload(encrypted, encryptionOptions);

    expect(decrypted).toBe(plaintext);
    expect(encrypted.orgId).toBe('org_123');
    expect(encrypted.kid).toBe('v1');
    expect(encrypted.data).not.toContain('prompt');
  });

  it('uses a unique IV for each encryption', async () => {
    const plaintext = 'same payload';

    const first = await encryptStoredBodyPayload(plaintext, encryptionOptions);
    const second = await encryptStoredBodyPayload(plaintext, encryptionOptions);

    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it('rejects invalid root keys', async () => {
    await expect(
      encryptStoredBodyPayload('payload', {
        ...encryptionOptions,
        rootKeyBase64: 'not-base64',
      }),
    ).rejects.toThrow('Body encryption root key must be valid base64');

    await expect(
      encryptStoredBodyPayload('payload', {
        ...encryptionOptions,
        rootKeyBase64: 'dG9vLXNob3J0',
      }),
    ).rejects.toThrow('Body encryption root key must decode to 32 bytes');
  });

  it('asserts a root key decodes to 32 bytes', () => {
    expect(() => assertBodyEncryptionRootKey(ROOT_KEY)).not.toThrow();
    expect(() => assertBodyEncryptionRootKey(undefined)).toThrow(
      'Body encryption root key is required',
    );
    expect(() => assertBodyEncryptionRootKey('')).toThrow('Body encryption root key is required');
    expect(() => assertBodyEncryptionRootKey('not-base64')).toThrow(
      'Body encryption root key must be valid base64',
    );
    // 64 hex chars is 32 bytes of entropy but base64-decodes to 48 bytes.
    expect(() => assertBodyEncryptionRootKey('0'.repeat(64))).toThrow(
      'Body encryption root key must decode to 32 bytes',
    );
  });

  it('fails decryption with the wrong root key', async () => {
    const encrypted = await encryptStoredBodyPayload('payload', encryptionOptions);

    await expect(
      decryptStoredBodyPayload(encrypted, {
        ...encryptionOptions,
        rootKeyBase64: OTHER_ROOT_KEY,
      }),
    ).rejects.toThrow();
  });

  it('fails decryption with the wrong org', async () => {
    const encrypted = await encryptStoredBodyPayload('payload', encryptionOptions);

    await expect(
      decryptStoredBodyPayload(encrypted, {
        ...encryptionOptions,
        orgId: 'org_other',
      }),
    ).rejects.toThrow('Encrypted body org does not match expected org');
  });

  it('fails decryption with the wrong object key', async () => {
    const encrypted = await encryptStoredBodyPayload('payload', encryptionOptions);

    await expect(
      decryptStoredBodyPayload(encrypted, {
        ...encryptionOptions,
        objectKey: 'bodies/req_other',
      }),
    ).rejects.toThrow();
  });

  it('fails decryption for malformed ciphertext', async () => {
    const encrypted = await encryptStoredBodyPayload('payload', encryptionOptions);

    await expect(
      decryptStoredBodyPayload(
        {
          ...encrypted,
          data: 'not-base64',
        },
        encryptionOptions,
      ),
    ).rejects.toThrow();
  });
});
