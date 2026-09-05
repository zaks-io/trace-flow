import { parseArchiveWrappedKeyVersion, unwrapArchiveEncryptionKey } from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError, type ArchiveScope } from './archive-contract';
import { type PlannedManifestObject } from './archive-packing';
import {
  assertPendingIntentAuthenticated,
  decodePendingPlaintext,
  encodePendingPlaintext,
  type PendingExpectedObject,
  type PendingIntent,
  markIntentReady,
  commitIntent,
} from './archive-ledger-intent';
import type { ArchiveR2Object } from './archive-r2';
import {
  storageBudgetObject,
  verifyEncryptedPlannedObject,
  verifyOrPutImmutableObject,
} from './archive-r2';
import type { LedgerSnapshot } from './archive-ledger-state';

export async function recoverPendingIntent(
  storage: DurableObjectStorage,
  env: ArchiveApiEnv,
  envelope: { scope: ArchiveScope; keyVersion: number; wrappedKey: string },
  state: LedgerSnapshot,
  pending: PendingIntent,
): Promise<void> {
  const archiveKey = await unwrapKey(env, envelope);
  const expectedObjects = await assertPendingIntentAuthenticated({
    ...pending,
    key: archiveKey,
    orgId: envelope.scope.orgId,
    keyVersion: envelope.keyVersion,
  });
  if (!pending.commit) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  if (
    JSON.stringify(pending.commit.scope) !== JSON.stringify(envelope.scope) ||
    pending.commit.keyVersion !== envelope.keyVersion ||
    pending.baseElementCount !== state.elementCount ||
    pending.baseChainHead !== state.chainHead
  ) {
    throw new ArchiveContractError('pending_intent_head_mismatch');
  }
  if (pending.status === 'building') markIntentReady(storage, pending.intentHash);
  const expected = new Map(
    expectedObjects.map((object) => [
      object.key,
      {
        objectClass: object.objectClass,
        plaintext: decodePendingPlaintext(object.plaintextBase64),
      },
    ]),
  );
  if (expected.size !== pending.objects.length) {
    throw new ArchiveContractError('pending_intent_mismatch');
  }
  for (const object of pending.objects) {
    const plan = expected.get(object.key);
    if (plan?.objectClass !== object.objectClass) {
      throw new ArchiveContractError('pending_intent_mismatch');
    }
    try {
      await verifyEncryptedPlannedObject(
        object,
        archiveKey,
        envelope.scope.orgId,
        envelope.keyVersion,
        plan.plaintext,
      );
    } catch (error) {
      if (error instanceof ArchiveContractError) throw error;
      throw new ArchiveContractError('pending_object_verification_failed');
    }
  }
  const budget = env.STORAGE_BUDGET.getByName(envelope.scope.orgId);
  const reservation = await budget.reserveStorage({
    orgId: envelope.scope.orgId,
    objects: pending.objects.map(storageBudgetObject),
  });
  if (!reservation.accepted) throw new ArchiveContractError('storage_cap_exceeded');
  await verifyObjects(env.ARCHIVE_STORAGE, pending.objects);
  await budget.commitStorage({
    orgId: envelope.scope.orgId,
    objects: pending.objects.map(storageBudgetObject),
  });
  commitIntent(storage, pending.intentHash, pending.commit, pending.acknowledgement);
  await budget.recordArchiveAcknowledgement({
    orgId: envelope.scope.orgId,
    acknowledgedAt: Date.now(),
  });
}

export function pendingExpectedObjects(
  expected: (
    | PlannedManifestObject
    | { key: string; body: string; objectClass: 'chunk'; plaintext: Uint8Array }
  )[],
): PendingExpectedObject[] {
  return expected.map((object) => ({
    key: object.key,
    objectClass: object.objectClass,
    plaintextBase64: encodePendingPlaintext(object.plaintext),
  }));
}

export function assertPendingIntentMatches(
  intent: PendingIntent,
  expected: { key: string; objectClass: ArchiveR2Object['objectClass'] }[],
): void {
  const actual = intent.objects.map(({ key, objectClass }) => ({ key, objectClass }));
  const expectedDescriptors = expected.map(({ key, objectClass }) => ({ key, objectClass }));
  if (JSON.stringify(actual) !== JSON.stringify(expectedDescriptors)) {
    throw new ArchiveContractError('pending_intent_mismatch');
  }
}

export async function verifyPendingIntentBodies(
  pending: ArchiveR2Object[],
  expected: (
    | PlannedManifestObject
    | { key: string; body: string; objectClass: 'chunk'; plaintext: Uint8Array }
  )[],
  key: CryptoKey,
  orgId: string,
  keyVersion: number,
): Promise<void> {
  const proofs = new Map(expected.map((object) => [object.key, object]));
  for (const object of pending) {
    const plan = proofs.get(object.key);
    if (plan?.objectClass !== object.objectClass) {
      throw new ArchiveContractError('pending_intent_mismatch');
    }
    try {
      await verifyEncryptedPlannedObject(object, key, orgId, keyVersion, plan.plaintext);
    } catch (error) {
      if (error instanceof ArchiveContractError) throw error;
      throw new ArchiveContractError('pending_object_verification_failed');
    }
  }
}

export async function unwrapKey(
  env: ArchiveApiEnv,
  envelope: { scope: ArchiveScope; keyVersion: number; wrappedKey: string },
): Promise<CryptoKey> {
  return unwrapArchiveEncryptionKey(
    parseArchiveWrappedKeyVersion(envelope.wrappedKey, {
      orgId: envelope.scope.orgId,
      keyVersion: envelope.keyVersion,
    }),
    {
      orgId: envelope.scope.orgId,
      keyVersion: envelope.keyVersion,
      wrappingSecretBase64: env.ARCHIVE_KEY_WRAPPING_SECRET,
    },
  );
}

export async function verifyObjects(bucket: R2Bucket, objects: ArchiveR2Object[]): Promise<void> {
  for (const object of objects) await verifyOrPutImmutableObject(bucket, object);
}
