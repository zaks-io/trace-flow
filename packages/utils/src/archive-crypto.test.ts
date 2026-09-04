import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createArchiveEncryptionKeyVersion,
  decryptArchiveObject,
  encryptArchiveObject,
  type ArchiveObjectEnvelope,
  unwrapArchiveEncryptionKey,
} from './archive-crypto';

const WRAPPING_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const OTHER_WRAPPING_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ORG_ID = 'org_archive_a';
const OTHER_ORG_ID = 'org_archive_b';
const OBJECT_KEY = 'archive/org_archive_a/contribution_a/session_a/chunk-0001';
const PLAINTEXT = new TextEncoder().encode('{"records":[{"content":"private archive"}]}');

type ArchiveMetadataPatch = Partial<
  Pick<ArchiveObjectEnvelope, 'orgId' | 'objectKey' | 'objectClass' | 'keyVersion'>
>;

function fixedBytes(start: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => start + index);
}

function mockRandomValues(...values: Uint8Array[]) {
  const remaining = [...values];
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    const next = remaining.shift();
    if (next?.byteLength !== array.byteLength) {
      throw new Error('unexpected deterministic random request');
    }
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(next);
    return array;
  });
}

async function makeFixture() {
  mockRandomValues(fixedBytes(1, 32), fixedBytes(101, 12), fixedBytes(201, 12));
  const wrappedKey = await createArchiveEncryptionKeyVersion({
    orgId: ORG_ID,
    keyVersion: 7,
    wrappingSecretBase64: WRAPPING_SECRET,
  });
  const key = await unwrapArchiveEncryptionKey(wrappedKey, {
    orgId: ORG_ID,
    keyVersion: 7,
    wrappingSecretBase64: WRAPPING_SECRET,
  });
  const envelope = await encryptArchiveObject(PLAINTEXT, {
    key,
    orgId: ORG_ID,
    objectKey: OBJECT_KEY,
    objectClass: 'chunk',
    keyVersion: 7,
  });
  return { wrappedKey, key, envelope };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Conversation Archive cryptography', () => {
  it('creates a deterministic wrapped-key and encrypted-envelope fixture', async () => {
    const { wrappedKey, envelope } = await makeFixture();

    expect(wrappedKey).toEqual({
      v: 1,
      alg: 'AES-GCM',
      orgId: ORG_ID,
      keyVersion: 7,
      nonce: 'ZWZnaGlqa2xtbm9w',
      ciphertext: 'FkdVqMmc6AUjsTXLMBcXDd4C+iBw/ld/UMqhV6/p5kj4ncBrG2KPIm+PJTca5aav',
    });
    expect(envelope).toEqual({
      v: 1,
      alg: 'AES-GCM',
      orgId: ORG_ID,
      objectKey: OBJECT_KEY,
      objectClass: 'chunk',
      keyVersion: 7,
      nonce: 'ycrLzM3Oz9DR0tPU',
      ciphertext:
        '2hoeW8TRxOJir2mOobPr+4q3VpZ6KKg5oglsVaeTp0vKCfJiCPj0O/VI0P0vCyfLTdtXQY0sH9k9tEM=',
    });
    expect(JSON.stringify(envelope)).not.toContain(new TextDecoder().decode(PLAINTEXT));
    expect(JSON.stringify(envelope)).not.toContain('private archive');
  });

  it('round-trips archive bytes with a non-extractable organization key', async () => {
    const { key, envelope } = await makeFixture();

    await expect(
      decryptArchiveObject(envelope, {
        key,
        orgId: ORG_ID,
        objectKey: OBJECT_KEY,
        objectClass: 'chunk',
        keyVersion: 7,
      }),
    ).resolves.toEqual(PLAINTEXT);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  const metadataTamperCases: [string, ArchiveMetadataPatch, ArchiveMetadataPatch][] = [
    ['organization', { orgId: OTHER_ORG_ID }, { orgId: OTHER_ORG_ID }],
    ['object key', { objectKey: 'archive/other-key' }, { objectKey: 'archive/other-key' }],
    ['object class', { objectClass: 'manifest' }, { objectClass: 'manifest' }],
    ['key version', { keyVersion: 8 }, { keyVersion: 8 }],
  ];

  it.each(metadataTamperCases)(
    'rejects %s changes through authenticated metadata',
    async (_name, envelopePatch, optionsPatch) => {
      const { key, envelope } = await makeFixture();
      const tamperedEnvelope = { ...envelope, ...envelopePatch } as ArchiveObjectEnvelope;

      await expect(
        decryptArchiveObject(tamperedEnvelope, {
          key,
          orgId: optionsPatch.orgId ?? ORG_ID,
          objectKey: optionsPatch.objectKey ?? OBJECT_KEY,
          objectClass: optionsPatch.objectClass ?? 'chunk',
          keyVersion: optionsPatch.keyVersion ?? 7,
        }),
      ).rejects.toThrow('Archive cryptographic operation failed');
    },
  );

  it('rejects wrong keys from another Organization', async () => {
    const first = await makeFixture();
    mockRandomValues(fixedBytes(33, 32), fixedBytes(121, 12));
    const otherWrappedKey = await createArchiveEncryptionKeyVersion({
      orgId: OTHER_ORG_ID,
      keyVersion: 7,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const otherKey = await unwrapArchiveEncryptionKey(otherWrappedKey, {
      orgId: OTHER_ORG_ID,
      keyVersion: 7,
      wrappingSecretBase64: WRAPPING_SECRET,
    });

    await expect(
      decryptArchiveObject(first.envelope, {
        key: otherKey,
        orgId: ORG_ID,
        objectKey: OBJECT_KEY,
        objectClass: 'chunk',
        keyVersion: 7,
      }),
    ).rejects.toThrow('Archive cryptographic operation failed');
  });

  it.each([
    ['nonce', (envelope: ArchiveObjectEnvelope) => ({ ...envelope, nonce: 'AQIDBAUGBwgJCgsM' })],
    [
      'ciphertext',
      (envelope: ArchiveObjectEnvelope) => ({
        ...envelope,
        ciphertext: `${envelope.ciphertext.slice(0, -2)}AA`,
      }),
    ],
  ])('rejects %s tampering', async (_name, mutate) => {
    const { key, envelope } = await makeFixture();

    await expect(
      decryptArchiveObject(mutate(envelope), {
        key,
        orgId: ORG_ID,
        objectKey: OBJECT_KEY,
        objectClass: 'chunk',
        keyVersion: 7,
      }),
    ).rejects.toThrow('Archive cryptographic operation failed');
  });

  it('rejects wrong wrapping secrets, key versions, and wrapped-key tampering', async () => {
    const { wrappedKey } = await makeFixture();

    await expect(
      unwrapArchiveEncryptionKey(wrappedKey, {
        orgId: ORG_ID,
        keyVersion: 7,
        wrappingSecretBase64: OTHER_WRAPPING_SECRET,
      }),
    ).rejects.toThrow('Archive cryptographic operation failed');
    await expect(
      unwrapArchiveEncryptionKey(
        { ...wrappedKey, keyVersion: 8 },
        {
          orgId: ORG_ID,
          keyVersion: 8,
          wrappingSecretBase64: WRAPPING_SECRET,
        },
      ),
    ).rejects.toThrow('Archive cryptographic operation failed');
    await expect(
      unwrapArchiveEncryptionKey(
        { ...wrappedKey, nonce: 'AQIDBAUGBwgJCgsM' },
        {
          orgId: ORG_ID,
          keyVersion: 7,
          wrappingSecretBase64: WRAPPING_SECRET,
        },
      ),
    ).rejects.toThrow('Archive cryptographic operation failed');
    await expect(
      unwrapArchiveEncryptionKey(
        { ...wrappedKey, ciphertext: 'AA==' },
        {
          orgId: ORG_ID,
          keyVersion: 7,
          wrappingSecretBase64: WRAPPING_SECRET,
        },
      ),
    ).rejects.toThrow('Archive cryptographic operation failed');
  });

  it('does not include secret material in cryptographic errors', async () => {
    const { envelope } = await makeFixture();
    const error = (await decryptArchiveObject(envelope, {
      key: {} as CryptoKey,
      orgId: ORG_ID,
      objectKey: OBJECT_KEY,
      objectClass: 'chunk',
      keyVersion: 7,
    }).catch((caught: unknown) => caught as Error)) as Error;

    expect(error.message).toBe('Archive cryptographic operation failed');
    expect(error.message).not.toContain(WRAPPING_SECRET);
    expect(error.message).not.toContain('private archive');
    expect(error.message).not.toContain(envelope.ciphertext);
  });
});
