import { describe, expect, it } from 'vitest';
import { api, internal } from '../_generated/api';
import {
  createArchiveEncryptionKeyVersion,
  decryptArchiveObject,
  encryptArchiveObject,
  parseArchiveWrappedKeyVersion,
  serializeArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
} from '@trace-flow/utils';
import { initConvexTest } from './convexTest.setup';
import { asUser, enableArchive, enrollInput, seedWorld } from './archiveControlPlaneTest.setup';

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
  it('adopts the latest legacy key row when custody is missing', async () => {
    const { t, orgA } = await seedOrganizations();
    const wrappingSecretBase64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
    const wrappedKeys = await Promise.all(
      [1, 2, 3].map(async (keyVersion) =>
        serializeArchiveWrappedKeyVersion(
          await createArchiveEncryptionKeyVersion({
            orgId: orgA,
            keyVersion,
            wrappingSecretBase64,
          }),
        ),
      ),
    );
    const activationId = await t.run(async (ctx) => {
      const organization = await ctx.db.get(orgA);
      if (!organization) throw new Error('Organization not found');
      await ctx.db.insert('archiveEncryptionKeyVersions', {
        orgId: orgA,
        keyVersion: 1,
        wrappedKey: wrappedKeys[0]!,
        createdAt: 1,
      });
      await ctx.db.insert('archiveEncryptionKeyVersions', {
        orgId: orgA,
        keyVersion: 2,
        wrappedKey: wrappedKeys[1]!,
        createdAt: 2,
      });
      return await ctx.db.insert('archiveActivations', {
        orgId: orgA,
        activatedByUserId: organization.ownerId,
        activatedAt: 1,
        capBytes: 100,
        status: 'active',
      });
    });

    await expect(
      t.query(internal.archiveKeysInternal.getActiveVersion, { orgId: orgA }),
    ).resolves.toEqual({
      orgId: orgA,
      keyVersion: 2,
      wrappedKey: wrappedKeys[1],
      activationId,
    });
    const activated = await t.mutation(internal.archiveKeysInternal.activateVersion, {
      orgId: orgA,
      keyVersion: 3,
      wrappedKey: wrappedKeys[2]!,
      operationId: 'rotate:legacy:2:3',
    });
    expect(activated).toMatchObject({
      fromVersion: 2,
      toVersion: 3,
      replay: false,
      activationId,
    });
    await expect(
      t.query(internal.archiveKeysInternal.getCustody, { orgId: orgA }),
    ).resolves.toMatchObject({
      activeKeyVersion: 3,
      retiringKeyVersion: 2,
      rotationOperationId: 'rotate:legacy:2:3',
      rotationStatus: 'rotating',
    });
  });

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
    expect(
      await t.mutation(internal.archiveKeysInternal.markRotationFailed, {
        orgId: orgA,
        operationId: 'rotate:org-a:1:2',
      }),
    ).toBe(false);
    expect(await t.query(internal.archiveKeysInternal.getCustody, { orgId: orgA })).toMatchObject({
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
    await expect(
      t.mutation(internal.archiveKeysInternal.activateVersion, {
        orgId: orgA,
        keyVersion: 3,
        wrappedKey: thirdWrappedKey,
        operationId: 'rotate:after-failure',
      }),
    ).rejects.toThrow('already in progress');
  });
});

async function authorizedUploadWorld() {
  enableArchive();
  const world = await seedWorld();
  const owner = asUser(world, world.owner);
  await owner.mutation(api.archive.activate, {});
  await owner.mutation(api.archive.enroll, enrollInput(world.ownerCred));
  return {
    ...world,
    args: {
      hashedSecret: 'hash-owner',
      source: 'claude' as const,
      orgId: world.owner.orgId,
      userId: world.owner._id,
      collectorId: 'collector-owner',
      now: Date.now(),
      keyVersion: 1,
    },
  };
}

async function wrappedKey(orgId: string, keyVersion: number) {
  return serializeArchiveWrappedKeyVersion(
    await createArchiveEncryptionKeyVersion({
      orgId,
      keyVersion,
      wrappingSecretBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    }),
  );
}

describe('first authorized upload key initialization', () => {
  it('persists one winner for concurrent first-upload candidates', async () => {
    const world = await authorizedUploadWorld();
    const candidates = await Promise.all([
      wrappedKey(world.owner.orgId, 1),
      wrappedKey(world.owner.orgId, 1),
      wrappedKey(world.owner.orgId, 1),
    ]);

    const results = await Promise.all(
      candidates.map((candidate) =>
        world.t.mutation(internal.archiveKeysInternal.initializeForAuthorizedUpload, {
          ...world.args,
          wrappedKey: candidate,
        }),
      ),
    );
    expect(results.every((result) => result.allowed)).toBe(true);
    const winners = new Set(results.map((result) => (result.allowed ? result.wrappedKey : null)));
    expect(winners.size).toBe(1);

    const state = await world.t.run(async (ctx) => ({
      versions: await ctx.db.query('archiveEncryptionKeyVersions').collect(),
      custody: await ctx.db.query('archiveEncryptionCustody').collect(),
    }));
    expect(state.versions).toHaveLength(1);
    expect(state.custody).toHaveLength(1);
    expect(state.custody[0]?.activeKeyVersion).toBe(1);
    expect(state.versions[0]?.wrappedKey).toBe([...winners][0]);
  });

  it('returns a committed winner when a retry carries a different candidate', async () => {
    const world = await authorizedUploadWorld();
    const first = await wrappedKey(world.owner.orgId, 1);
    const retry = await wrappedKey(world.owner.orgId, 1);
    await world.t.mutation(internal.archiveKeysInternal.initializeForAuthorizedUpload, {
      ...world.args,
      wrappedKey: first,
    });
    const result = await world.t.mutation(
      internal.archiveKeysInternal.initializeForAuthorizedUpload,
      { ...world.args, wrappedKey: retry },
    );
    expect(result).toEqual({ allowed: true, keyVersion: 1, wrappedKey: first });
  });

  it('preserves active rotation custody and returns its current active key', async () => {
    const world = await authorizedUploadWorld();
    const first = await wrappedKey(world.owner.orgId, 1);
    const second = await wrappedKey(world.owner.orgId, 2);
    await world.t.mutation(internal.archiveKeysInternal.storeVersion, {
      orgId: world.owner.orgId,
      keyVersion: 1,
      wrappedKey: first,
    });
    await world.t.mutation(internal.archiveKeysInternal.activateVersion, {
      orgId: world.owner.orgId,
      keyVersion: 2,
      wrappedKey: second,
      operationId: 'rotate:first-upload:1:2',
    });
    const before = await world.t.query(internal.archiveKeysInternal.getCustody, {
      orgId: world.owner.orgId,
    });

    const result = await world.t.mutation(
      internal.archiveKeysInternal.initializeForAuthorizedUpload,
      { ...world.args, wrappedKey: await wrappedKey(world.owner.orgId, 1) },
    );
    expect(result).toEqual({ allowed: true, keyVersion: 2, wrappedKey: second });
    await expect(
      world.t.query(internal.archiveKeysInternal.getCustody, { orgId: world.owner.orgId }),
    ).resolves.toEqual(before);
  });

  it('reuses a valid legacy key without creating custody', async () => {
    const world = await authorizedUploadWorld();
    const legacy = await wrappedKey(world.owner.orgId, 3);
    await world.t.run(async (ctx) => {
      await ctx.db.insert('archiveEncryptionKeyVersions', {
        orgId: world.owner.orgId,
        keyVersion: 3,
        wrappedKey: legacy,
        createdAt: 1,
      });
    });
    const result = await world.t.mutation(
      internal.archiveKeysInternal.initializeForAuthorizedUpload,
      { ...world.args, wrappedKey: await wrappedKey(world.owner.orgId, 1) },
    );
    expect(result).toEqual({ allowed: true, keyVersion: 3, wrappedKey: legacy });
    await expect(
      world.t.query(internal.archiveKeysInternal.getCustody, { orgId: world.owner.orgId }),
    ).resolves.toBeNull();
  });

  it.each(['missing_active', 'malformed_active', 'malformed_legacy'] as const)(
    'fails closed without writes for %s key state',
    async (state) => {
      const world = await authorizedUploadWorld();
      await world.t.run(async (ctx) => {
        if (state === 'missing_active') {
          await ctx.db.insert('archiveEncryptionCustody', {
            orgId: world.owner.orgId,
            activeKeyVersion: 7,
            updatedAt: 1,
          });
        } else {
          await ctx.db.insert('archiveEncryptionKeyVersions', {
            orgId: world.owner.orgId,
            keyVersion: 1,
            wrappedKey: '{"malformed":true}',
            createdAt: 1,
          });
          if (state === 'malformed_active') {
            await ctx.db.insert('archiveEncryptionCustody', {
              orgId: world.owner.orgId,
              activeKeyVersion: 1,
              updatedAt: 1,
            });
          }
        }
      });
      const before = await world.t.run(async (ctx) => ({
        versions: await ctx.db.query('archiveEncryptionKeyVersions').collect(),
        custody: await ctx.db.query('archiveEncryptionCustody').collect(),
      }));

      await expect(
        world.t.mutation(internal.archiveKeysInternal.initializeForAuthorizedUpload, {
          ...world.args,
          wrappedKey: await wrappedKey(world.owner.orgId, 1),
        }),
      ).rejects.toThrow('Active archive key is unavailable');
      const after = await world.t.run(async (ctx) => ({
        versions: await ctx.db.query('archiveEncryptionKeyVersions').collect(),
        custody: await ctx.db.query('archiveEncryptionCustody').collect(),
      }));
      expect(after).toEqual(before);
    },
  );

  it.each(['revoked', 'deleting'] as const)(
    'denies initialization after authorization is %s and writes nothing',
    async (state) => {
      const world = await authorizedUploadWorld();
      await world.t.run(async (ctx) => {
        if (state === 'revoked') await ctx.db.patch(world.ownerCred, { status: 'revoked' });
        else await ctx.db.patch(world.owner.orgId, { deletionStartedAt: Date.now() });
      });
      const result = await world.t.mutation(
        internal.archiveKeysInternal.initializeForAuthorizedUpload,
        { ...world.args, wrappedKey: await wrappedKey(world.owner.orgId, 1) },
      );
      expect(result).toEqual({
        allowed: false,
        reason: state === 'revoked' ? 'credential_revoked' : 'deleting',
      });
      const counts = await world.t.run(async (ctx) => ({
        versions: (await ctx.db.query('archiveEncryptionKeyVersions').collect()).length,
        custody: (await ctx.db.query('archiveEncryptionCustody').collect()).length,
      }));
      expect(counts).toEqual({ versions: 0, custody: 0 });
    },
  );

  it('rejects an invalid candidate before writing', async () => {
    const world = await authorizedUploadWorld();
    await expect(
      world.t.mutation(internal.archiveKeysInternal.initializeForAuthorizedUpload, {
        ...world.args,
        wrappedKey: '{"invalid":true}',
      }),
    ).rejects.toThrow('Archive cryptographic operation failed');
    expect(
      await world.t.run(async (ctx) => ctx.db.query('archiveEncryptionKeyVersions').collect()),
    ).toHaveLength(0);
  });
});
