import { describe, expect, it } from 'vitest';
import {
  createArchiveEncryptionKeyVersion,
  decryptArchiveObject,
  encryptArchiveObject,
  unwrapArchiveEncryptionKey,
} from '@trace-flow/utils';

const ARCHIVE_CHUNK_BYTES = 1.5 * 1024 * 1024;
const CONCURRENT_CHUNKS = 2;
const MEMORY_RESERVE_BYTES = 16 * 1024 * 1024;
const WRAPPING_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const ORG_ID = 'org_archive_memory';

describe('Conversation Archive workerd memory', () => {
  it('round-trips two concurrent 1.5 MiB chunks with a live memory reserve', async () => {
    const wrappedKey = await createArchiveEncryptionKeyVersion({
      orgId: ORG_ID,
      keyVersion: 1,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const key = await unwrapArchiveEncryptionKey(wrappedKey, {
      orgId: ORG_ID,
      keyVersion: 1,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const memoryReserve = new Uint8Array(MEMORY_RESERVE_BYTES);
    memoryReserve.fill(0xa5);

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_CHUNKS }, async (_, index) => {
        const plaintext = new Uint8Array(ARCHIVE_CHUNK_BYTES);
        plaintext.fill(index + 1);
        const objectKey = `archive/${ORG_ID}/memory/chunk-${index}`;
        const envelope = await encryptArchiveObject(plaintext, {
          key,
          orgId: ORG_ID,
          objectKey,
          objectClass: 'chunk',
          keyVersion: 1,
        });
        const decrypted = await decryptArchiveObject(envelope, {
          key,
          orgId: ORG_ID,
          objectKey,
          objectClass: 'chunk',
          keyVersion: 1,
        });

        return decrypted[0] === index + 1 && decrypted[decrypted.byteLength - 1] === index + 1;
      }),
    );

    expect(results).toEqual([true, true]);
    expect(memoryReserve[0]).toBe(0xa5);
    expect(memoryReserve[MEMORY_RESERVE_BYTES - 1]).toBe(0xa5);
  }, 60_000);
});
