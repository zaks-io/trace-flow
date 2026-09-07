import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ArchiveApiEnv } from '../context';
import { verifyOrPutImmutableObject } from '../archive-r2';

const runtimeEnv = env as unknown as ArchiveApiEnv;

describe('Archive R2 conditional writes', () => {
  it('fences a delayed old commit put after a replacement lands', async () => {
    const key = `conditional/${crypto.randomUUID()}`;
    const oldBody = '{"keyVersion":9,"body":"old"}';
    const newBody = '{"keyVersion":10,"body":"new"}';
    let releasePut!: () => void;
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let signalPut!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      signalPut = resolve;
    });
    let reads = 0;
    const delayedBucket = {
      get: async (objectKey: string) => {
        reads += 1;
        if (reads === 1) return null;
        return runtimeEnv.ARCHIVE_STORAGE.get(objectKey);
      },
      put: async (objectKey: string, body: string, options?: R2PutOptions) => {
        signalPut();
        await putReleased;
        return runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body, options);
      },
    } as unknown as R2Bucket;
    const delayed = verifyOrPutImmutableObject(delayedBucket, {
      key,
      body: oldBody,
      objectClass: 'chunk',
    });
    await putStarted;
    await runtimeEnv.ARCHIVE_STORAGE.put(key, newBody);
    releasePut();
    await expect(delayed).rejects.toThrow('r2_object_verification_failed');
    await expect(
      runtimeEnv.ARCHIVE_STORAGE.get(key).then((object) => object?.text()),
    ).resolves.toBe(newBody);
  });
});
