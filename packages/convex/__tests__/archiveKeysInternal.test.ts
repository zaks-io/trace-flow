import { describe, expect, it } from 'vitest';
import { internal } from '../_generated/api';
import {
  createArchiveEncryptionKeyVersion,
  decryptArchiveObject,
  encryptArchiveObject,
  parseArchiveWrappedKeyVersion,
  serializeArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
} from '@trace-flow/utils';
import { initConvexTest } from './convexTest.setup';

async function seedOrganizations() {
  const t = initConvexTest();
  const ids = await t.run(async (ctx) => {
    const ownerA = await ctx.db.insert('users', {
      tokenIdentifier: 'archive-key-test-owner-a',
      email: 'archive-key-a@example.com',
      enabled: true,
    });
    const ownerB = await ctx.db.insert('users', {
      tokenIdentifier: 'archive-key-test-owner-b',
      email: 'archive-key-b@example.com',
      enabled: true,
    });
    const orgA = await ctx.db.insert('organizations', { name: 'Archive A', ownerId: ownerA });
    const orgB = await ctx.db.insert('organizations', { name: 'Archive B', ownerId: ownerB });
    return { orgA, orgB };
  });
  return { t, ...ids };
}

function base64Bytes(length: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(length)));
}

describe('archive key metadata internal boundary', () => {
  it('stores opaque wrapped versions per Organization and supports idempotent replay', async () => {
    const { t, orgA, orgB } = await seedOrganizations();
    await expect(
      t.mutation(internal.archiveKeysInternal.storeVersion, {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: '{"v":1,"ciphertext":"opaque"}',
      }),
    ).rejects.toThrow('Archive cryptographic operation failed');
    const wrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 1,
        wrappingSecretBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      }),
    );
    const otherOrganizationWrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgB,
        keyVersion: 1,
        wrappingSecretBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      }),
    );
    const validWrappedKeyRecord = JSON.parse(wrappedKey) as Record<string, unknown>;
    for (const ciphertextBytes of [47, 49]) {
      const malformedWrappedKey = JSON.stringify({
        ...validWrappedKeyRecord,
        ciphertext: base64Bytes(ciphertextBytes),
      });
      await expect(
        t.mutation(internal.archiveKeysInternal.storeVersion, {
          orgId: orgA,
          keyVersion: 1,
          wrappedKey: malformedWrappedKey,
        }),
      ).rejects.toThrow('Archive cryptographic operation failed');
      await expect(
        t.query(internal.archiveKeysInternal.getVersion, {
          orgId: orgA,
          keyVersion: 1,
        }),
      ).resolves.toBeNull();
    }
    await expect(
      t.mutation(internal.archiveKeysInternal.storeVersion, {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: `${wrappedKey.slice(0, -1)},"plaintext":"private archive"}`,
      }),
    ).rejects.toThrow('Archive cryptographic operation failed');
    await expect(
      t.mutation(internal.archiveKeysInternal.storeVersion, {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: otherOrganizationWrappedKey,
      }),
    ).rejects.toThrow('Archive cryptographic operation failed');

    const firstId = await t.mutation(internal.archiveKeysInternal.storeVersion, {
      orgId: orgA,
      keyVersion: 1,
      wrappedKey,
    });
    const replayId = await t.mutation(internal.archiveKeysInternal.storeVersion, {
      orgId: orgA,
      keyVersion: 1,
      wrappedKey,
    });
    expect(replayId).toBe(firstId);
    await expect(
      t.mutation(internal.archiveKeysInternal.storeVersion, {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: serializeArchiveWrappedKeyVersion(
          await createArchiveEncryptionKeyVersion({
            orgId: orgA,
            keyVersion: 1,
            wrappingSecretBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          }),
        ),
      }),
    ).rejects.toThrow('Archive key version already exists');

    expect(
      await t.query(internal.archiveKeysInternal.getVersion, {
        orgId: orgA,
        keyVersion: 1,
      }),
    ).toEqual({ orgId: orgA, keyVersion: 1, wrappedKey });
    expect(
      await t.query(internal.archiveKeysInternal.getVersion, {
        orgId: orgB,
        keyVersion: 1,
      }),
    ).toBeNull();
  });

  it.each([47, 49])(
    'repairs a seeded invalid %d-byte same-organization/version row before idempotency checks',
    async (ciphertextBytes) => {
      const { t, orgA } = await seedOrganizations();
      const wrappingSecretBase64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
      const validWrappedKey = serializeArchiveWrappedKeyVersion(
        await createArchiveEncryptionKeyVersion({
          orgId: orgA,
          keyVersion: 1,
          wrappingSecretBase64,
        }),
      );
      const validWrappedKeyRecord = JSON.parse(validWrappedKey) as Record<string, unknown>;
      const invalidWrappedKey = JSON.stringify({
        ...validWrappedKeyRecord,
        ciphertext: base64Bytes(ciphertextBytes),
      });
      const seededId = await t.run(async (ctx) =>
        ctx.db.insert('archiveEncryptionKeyVersions', {
          orgId: orgA,
          keyVersion: 1,
          wrappedKey: invalidWrappedKey,
          createdAt: 1,
        }),
      );

      await expect(
        t.query(internal.archiveKeysInternal.getVersion, {
          orgId: orgA,
          keyVersion: 1,
        }),
      ).resolves.toEqual({ orgId: orgA, keyVersion: 1, wrappedKey: invalidWrappedKey });

      const repairedId = await t.mutation(internal.archiveKeysInternal.storeVersion, {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: validWrappedKey,
      });
      expect(repairedId).toBe(seededId);
      await expect(
        t.query(internal.archiveKeysInternal.getVersion, {
          orgId: orgA,
          keyVersion: 1,
        }),
      ).resolves.toEqual({ orgId: orgA, keyVersion: 1, wrappedKey: validWrappedKey });

      const replayId = await t.mutation(internal.archiveKeysInternal.storeVersion, {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: validWrappedKey,
      });
      expect(replayId).toBe(seededId);
    },
  );

  it('does not replace a different valid same-organization/version row', async () => {
    const { t, orgA } = await seedOrganizations();
    const wrappingSecretBase64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
    const firstWrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 1,
        wrappingSecretBase64,
      }),
    );
    const differentValidWrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 1,
        wrappingSecretBase64,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert('archiveEncryptionKeyVersions', {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: firstWrappedKey,
        createdAt: 1,
      }),
    );

    await expect(
      t.mutation(internal.archiveKeysInternal.storeVersion, {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: differentValidWrappedKey,
      }),
    ).rejects.toThrow('Archive key version already exists');
    expect(
      await t.query(internal.archiveKeysInternal.getVersion, {
        orgId: orgA,
        keyVersion: 1,
      }),
    ).toEqual({ orgId: orgA, keyVersion: 1, wrappedKey: firstWrappedKey });
  });

  it('destroys the exact wrapped version and leaves other Organizations untouched', async () => {
    const { t, orgA, orgB } = await seedOrganizations();
    const wrappingSecretBase64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
    const wrappedKey = await createArchiveEncryptionKeyVersion({
      orgId: orgA,
      keyVersion: 1,
      wrappingSecretBase64,
    });
    const wrappedKeySerialized = serializeArchiveWrappedKeyVersion(wrappedKey);
    await t.mutation(internal.archiveKeysInternal.storeVersion, {
      orgId: orgA,
      keyVersion: 1,
      wrappedKey: wrappedKeySerialized,
    });
    const key = await unwrapArchiveEncryptionKey(
      parseArchiveWrappedKeyVersion(wrappedKeySerialized, { orgId: orgA, keyVersion: 1 }),
      { orgId: orgA, keyVersion: 1, wrappingSecretBase64 },
    );
    const objectKey = 'archive/org_a/session_a/chunk-0001';
    const envelope = await encryptArchiveObject(new TextEncoder().encode('archive bytes'), {
      key,
      orgId: orgA,
      objectKey,
      objectClass: 'chunk',
      keyVersion: 1,
    });
    const wrappedKeyVersion2 = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 2,
        wrappingSecretBase64,
      }),
    );
    await t.mutation(internal.archiveKeysInternal.storeVersion, {
      orgId: orgA,
      keyVersion: 2,
      wrappedKey: wrappedKeyVersion2,
    });
    const wrappedKeyOtherOrganization = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgB,
        keyVersion: 1,
        wrappingSecretBase64,
      }),
    );
    await t.mutation(internal.archiveKeysInternal.storeVersion, {
      orgId: orgB,
      keyVersion: 1,
      wrappedKey: wrappedKeyOtherOrganization,
    });

    const stored = await t.query(internal.archiveKeysInternal.getVersion, {
      orgId: orgA,
      keyVersion: 1,
    });
    expect(stored).not.toBeNull();
    const storedKey = await unwrapArchiveEncryptionKey(
      parseArchiveWrappedKeyVersion(stored!.wrappedKey, { orgId: orgA, keyVersion: 1 }),
      { orgId: orgA, keyVersion: 1, wrappingSecretBase64 },
    );
    await expect(
      decryptArchiveObject(envelope, {
        key: storedKey,
        orgId: orgA,
        objectKey,
        objectClass: 'chunk',
        keyVersion: 1,
      }),
    ).resolves.toEqual(new TextEncoder().encode('archive bytes'));

    await expect(
      t.mutation(internal.archiveKeysInternal.destroyVersion, {
        orgId: orgA,
        keyVersion: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      t.query(internal.archiveKeysInternal.getVersion, {
        orgId: orgA,
        keyVersion: 1,
      }),
    ).resolves.toBeNull();
    const deleted = await t.query(internal.archiveKeysInternal.getVersion, {
      orgId: orgA,
      keyVersion: 1,
    });
    expect(deleted).toBeNull();
    await expect(
      (async () => {
        if (!deleted) throw new Error('Archive key version unavailable');
        const reloadedKey = await unwrapArchiveEncryptionKey(
          parseArchiveWrappedKeyVersion(deleted.wrappedKey, { orgId: orgA, keyVersion: 1 }),
          { orgId: orgA, keyVersion: 1, wrappingSecretBase64 },
        );
        return decryptArchiveObject(envelope, {
          key: reloadedKey,
          orgId: orgA,
          objectKey,
          objectClass: 'chunk',
          keyVersion: 1,
        });
      })(),
    ).rejects.toThrow('Archive key version unavailable');
    await expect(
      t.query(internal.archiveKeysInternal.getVersion, {
        orgId: orgA,
        keyVersion: 2,
      }),
    ).resolves.toEqual({
      orgId: orgA,
      keyVersion: 2,
      wrappedKey: wrappedKeyVersion2,
    });
    await expect(
      t.query(internal.archiveKeysInternal.getVersion, {
        orgId: orgB,
        keyVersion: 1,
      }),
    ).resolves.toEqual({
      orgId: orgB,
      keyVersion: 1,
      wrappedKey: wrappedKeyOtherOrganization,
    });
  });

  it('activates the next version atomically and refuses destroy while refs remain', async () => {
    const { t, orgA } = await seedOrganizations();
    const wrappingSecretBase64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
    const firstWrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 1,
        wrappingSecretBase64,
      }),
    );
    const secondWrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 2,
        wrappingSecretBase64,
      }),
    );
    await t.mutation(internal.archiveKeysInternal.storeVersion, {
      orgId: orgA,
      keyVersion: 1,
      wrappedKey: firstWrappedKey,
    });
    expect(await t.query(internal.archiveKeysInternal.getActiveVersion, { orgId: orgA })).toEqual({
      orgId: orgA,
      keyVersion: 1,
      wrappedKey: firstWrappedKey,
    });

    const first = await t.mutation(internal.archiveKeysInternal.activateVersion, {
      orgId: orgA,
      keyVersion: 2,
      wrappedKey: secondWrappedKey,
      operationId: 'rotate:org-a:1:2',
    });
    expect(first).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      replay: false,
      operationId: 'rotate:org-a:1:2',
    });
    const replay = await t.mutation(internal.archiveKeysInternal.activateVersion, {
      orgId: orgA,
      keyVersion: 2,
      wrappedKey: secondWrappedKey,
      operationId: 'rotate:org-a:1:2',
    });
    expect(replay.replay).toBe(true);
    expect(
      await t.query(internal.archiveKeysInternal.getActiveVersion, { orgId: orgA }),
    ).toMatchObject({
      orgId: orgA,
      keyVersion: 2,
      wrappedKey: secondWrappedKey,
      retiringKeyVersion: 1,
      rotationStatus: 'rotating',
    });

    await expect(
      t.mutation(internal.archiveKeysInternal.destroyRetiringVersion, {
        orgId: orgA,
        keyVersion: 1,
        operationId: 'rotate:org-a:1:2',
        liveReferenceCount: 2,
      }),
    ).rejects.toThrow('live object references');
    await expect(
      t.mutation(internal.archiveKeysInternal.destroyRetiringVersion, {
        orgId: orgA,
        keyVersion: 2,
        operationId: 'rotate:org-a:1:2',
        liveReferenceCount: 0,
      }),
    ).rejects.toThrow('Active archive key cannot be destroyed');
    expect(
      await t.query(internal.archiveKeysInternal.getVersion, { orgId: orgA, keyVersion: 1 }),
    ).toEqual({ orgId: orgA, keyVersion: 1, wrappedKey: firstWrappedKey });

    await expect(
      t.mutation(internal.archiveKeysInternal.destroyRetiringVersion, {
        orgId: orgA,
        keyVersion: 1,
        operationId: 'rotate:org-a:1:2',
        liveReferenceCount: 0,
      }),
    ).resolves.toBe(true);
    await expect(
      t.query(internal.archiveKeysInternal.getVersion, { orgId: orgA, keyVersion: 1 }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(internal.archiveKeysInternal.destroyRetiringVersion, {
        orgId: orgA,
        keyVersion: 1,
        operationId: 'rotate:org-a:1:2',
        liveReferenceCount: 0,
      }),
    ).resolves.toBe(true);
    expect(await t.query(internal.archiveKeysInternal.getCustody, { orgId: orgA })).toMatchObject({
      activeKeyVersion: 2,
      rotationStatus: 'succeeded',
    });
  });

  it('refuses a skipped version, a second in-flight operation, and destroy with the wrong operation', async () => {
    const { t, orgA } = await seedOrganizations();
    const wrappingSecretBase64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
    const firstWrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 1,
        wrappingSecretBase64,
      }),
    );
    const thirdWrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 3,
        wrappingSecretBase64,
      }),
    );
    const secondWrappedKey = serializeArchiveWrappedKeyVersion(
      await createArchiveEncryptionKeyVersion({
        orgId: orgA,
        keyVersion: 2,
        wrappingSecretBase64,
      }),
    );
    await t.mutation(internal.archiveKeysInternal.storeVersion, {
      orgId: orgA,
      keyVersion: 1,
      wrappedKey: firstWrappedKey,
    });
    await expect(
      t.mutation(internal.archiveKeysInternal.activateVersion, {
        orgId: orgA,
        keyVersion: 3,
        wrappedKey: thirdWrappedKey,
        operationId: 'rotate:skip',
      }),
    ).rejects.toThrow('increment by one');
    await t.mutation(internal.archiveKeysInternal.activateVersion, {
      orgId: orgA,
      keyVersion: 2,
      wrappedKey: secondWrappedKey,
      operationId: 'rotate:first',
    });
    await expect(
      t.mutation(internal.archiveKeysInternal.activateVersion, {
        orgId: orgA,
        keyVersion: 3,
        wrappedKey: thirdWrappedKey,
        operationId: 'rotate:second',
      }),
    ).rejects.toThrow('already in progress');
    await expect(
      t.mutation(internal.archiveKeysInternal.destroyRetiringVersion, {
        orgId: orgA,
        keyVersion: 1,
        operationId: 'rotate:other',
        liveReferenceCount: 0,
      }),
    ).rejects.toThrow('does not match');
    expect(
      await t.mutation(internal.archiveKeysInternal.markRotationFailed, {
        orgId: orgA,
        operationId: 'rotate:first',
      }),
    ).toBe(true);
    expect(
      await t.mutation(internal.archiveKeysInternal.markRotationFailed, {
        orgId: orgA,
        operationId: 'rotate:first',
      }),
    ).toBe(true);
    expect(await t.query(internal.archiveKeysInternal.getCustody, { orgId: orgA })).toMatchObject({
      rotationStatus: 'failed',
      retiringKeyVersion: 1,
      activeKeyVersion: 2,
    });
  });
});
