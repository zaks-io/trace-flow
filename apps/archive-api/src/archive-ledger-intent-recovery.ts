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
  markIntentWriteAuthorized,
  commitIntent,
  discardPendingIntent,
} from './archive-ledger-intent';
import type { ArchiveR2Object } from './archive-r2';
import {
  ArchiveR2BatchWriteError,
  didAttemptWrite,
  storageBudgetObject,
  verifyEncryptedPlannedObject,
  verifyOrPutImmutableObject,
} from './archive-r2';
import { assertPlannedChain } from './archive-chain';
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
  await assertPlannedChain(
    pending.baseChainHead,
    pending.baseElementCount,
    pending.commit.newElements,
  );
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
  if (!reservation.accepted) {
    await discardDefinitelyUnwrittenIntent(storage, budget, envelope.scope.orgId, pending);
    throw new ArchiveContractError('storage_cap_exceeded');
  }
  if (pending.status !== 'write_authorized') {
    markIntentWriteAuthorized(storage, pending.intentHash);
  }
  await verifyObjectsAndReleaseDefinitivelyUnwritten(
    env.ARCHIVE_STORAGE,
    pending.objects,
    (unwritten) =>
      budget.releaseStorage({
        orgId: envelope.scope.orgId,
        objects: unwritten.map(storageBudgetObject),
      }),
  );
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

export async function discardDefinitelyUnwrittenIntent(
  storage: DurableObjectStorage,
  budget: {
    releaseStorage(input: {
      orgId: string;
      objects: ReturnType<typeof storageBudgetObject>[];
    }): Promise<unknown>;
  },
  orgId: string,
  pending: PendingIntent,
): Promise<void> {
  if (pending.status === 'write_authorized') return;
  await budget.releaseStorage({
    orgId,
    objects: pending.objects.map(storageBudgetObject),
  });
  discardPendingIntent(storage, pending.intentHash);
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

async function verifyObjects(bucket: R2Bucket, objects: ArchiveR2Object[]): Promise<void> {
  for (const [index, object] of objects.entries()) {
    try {
      await verifyOrPutImmutableObject(bucket, object);
    } catch (error) {
      throw new ArchiveR2BatchWriteError(
        error,
        objects.slice(index + (didAttemptWrite(error) ? 1 : 0)),
      );
    }
  }
}

async function definitelyUnwrittenObjects(
  bucket: R2Bucket,
  objects: ArchiveR2Object[],
): Promise<ArchiveR2Object[]> {
  const unwritten: ArchiveR2Object[] = [];
  for (const object of objects) {
    try {
      if ((await bucket.head(object.key)) === null) unwritten.push(object);
    } catch {
      // An ambiguous inventory result must retain the reservation for recovery.
    }
  }
  return unwritten;
}

export async function verifyObjectsAndReleaseDefinitivelyUnwritten(
  bucket: R2Bucket,
  objects: ArchiveR2Object[],
  release: (objects: ArchiveR2Object[]) => Promise<unknown>,
): Promise<void> {
  try {
    await verifyObjects(bucket, objects);
  } catch (error) {
    if (error instanceof ArchiveR2BatchWriteError) {
      const unwritten = await definitelyUnwrittenObjects(bucket, error.definitelyUnwritten);
      if (unwritten.length > 0) {
        try {
          await release(unwritten);
        } catch {
          // An ambiguous release must leave the reservation for recovery.
        }
      }
      throw error.cause;
    }
    throw error;
  }
}
