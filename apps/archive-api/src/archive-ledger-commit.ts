import { parseArchiveWrappedKeyVersion, unwrapArchiveEncryptionKey } from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError, type ArchiveScope } from './archive-contract';
import { packNewElementsPaged, type PlannedManifestObject } from './archive-packing';
import {
  assertIncomingObservationCount,
  parseAndValidateUpload,
  sourceFingerprints,
} from './archive-validation';
import {
  verifyEncryptedPlannedObject,
  verifyOrPutImmutableObject,
  type ArchiveR2Object,
} from './archive-r2';
import {
  type ArchiveAcknowledgement,
  type LedgerCommit,
  type LedgerSnapshot,
} from './archive-ledger-state';
import { readLedgerScan, readLedgerSnapshot } from './archive-ledger-storage';
import {
  commitIntent,
  readIntent,
  readPendingIntent,
  markIntentReady,
  writeIntent,
  type PendingIntent,
} from './archive-ledger-intent';
import { reconcileArchiveUpload } from './archive-ledger-reconciliation';
import { buildAcknowledgement, intentDigest, parseCommitEnvelope } from './archive-ledger-support';

export async function commitArchiveSession(
  storage: DurableObjectStorage,
  env: ArchiveApiEnv,
  value: unknown,
): Promise<ArchiveAcknowledgement> {
  const envelope = parseCommitEnvelope(value);
  assertIncomingObservationCount(envelope.upload);
  let state = readLedgerSnapshot(storage);
  state = assertScope(state, envelope.scope);
  const upload = await parseAndValidateUpload(envelope.upload, envelope.scope);
  const scan = readLedgerScan(storage, upload.checkpoint.source_transcript_part_id);
  const configuredKeyVersion = Number(env.ARCHIVE_KEY_VERSION);
  if (envelope.keyVersion !== configuredKeyVersion) {
    throw new ArchiveContractError('archive_key_version_mismatch');
  }
  if (state.keyVersion !== undefined && state.keyVersion !== envelope.keyVersion) {
    throw new ArchiveContractError('archive_key_version_mismatch');
  }

  const intentHash = await intentDigest({ scope: envelope.scope, upload });
  const priorIntent = readIntent(storage, intentHash);
  if (priorIntent?.status === 'committed') return priorIntent.acknowledgement;
  const existingPending = readPendingIntent(storage);
  if (existingPending && existingPending.intentHash !== intentHash) {
    throw new ArchiveContractError('pending_commit_exists');
  }
  if (
    priorIntent &&
    (priorIntent.baseElementCount !== state.elementCount ||
      priorIntent.baseChainHead !== state.chainHead)
  ) {
    throw new ArchiveContractError('pending_intent_head_mismatch');
  }

  const { newElements, appendCheckpoint } = await reconcileArchiveUpload(
    storage,
    state,
    upload,
    scan,
  );
  if (newElements.length === 0) return buildAcknowledgement(state, true, 0, false, []);

  const ledgerElements = newElements.map((element) => {
    if (element.kind !== 'record') return element;
    const { payload: _payload, ...metadata } = element;
    return metadata;
  });
  const nextState: LedgerSnapshot = {
    ...state,
    scope: envelope.scope,
    keyVersion: envelope.keyVersion,
    elementCount: state.elementCount + ledgerElements.length,
    recordCount:
      state.recordCount + ledgerElements.filter((element) => element.kind === 'record').length,
    chainHead: ledgerElements.at(-1)?.chain_hash ?? state.chainHead,
    generation: state.generation + 1,
    manifestKey: undefined,
    manifestHeadPageKey: state.manifestHeadPageKey,
  };
  const archiveKey = await unwrapKey(env, envelope);
  const plan = await packNewElementsPaged(
    envelope.scope,
    storage,
    state.elementCount,
    newElements,
    nextState.generation,
    nextState.chainHead,
    archiveKey,
    envelope.keyVersion,
    async (chunk) => {
      await verifyEncryptedPlannedObject(
        { key: chunk.objectKey, body: chunk.encryptedBody, objectClass: 'chunk' },
        archiveKey,
        envelope.scope.orgId,
        envelope.keyVersion,
        chunk.plainBytes,
      );
    },
    state.manifestHeadPageKey,
  );
  nextState.manifestKey = plan.manifestKey;
  nextState.manifestHeadPageKey = plan.manifestHeadPageKey;
  const objects: ArchiveR2Object[] = [
    ...plan.chunks.map((chunk) => ({
      key: chunk.objectKey,
      body: chunk.encryptedBody,
      objectClass: 'chunk' as const,
    })),
    ...plan.manifestObjects.map(({ key, body }) => ({
      key,
      body,
      objectClass: 'manifest' as const,
    })),
  ];
  for (const manifestObject of plan.manifestObjects) {
    await verifyEncryptedPlannedObject(
      { key: manifestObject.key, body: manifestObject.body, objectClass: 'manifest' },
      archiveKey,
      envelope.scope.orgId,
      envelope.keyVersion,
      manifestObject.plaintext,
    );
  }
  const acknowledgement = buildAcknowledgement(
    nextState,
    false,
    newElements.filter((element) => element.kind === 'record').length,
    appendCheckpoint,
    plan.chunks.map((chunk) => chunk.objectKey),
  );
  const intent: PendingIntent = {
    intentHash,
    status: 'building',
    baseElementCount: state.elementCount,
    baseChainHead: state.chainHead,
    objects,
    acknowledgement,
  };
  const commit: LedgerCommit = {
    scope: envelope.scope,
    keyVersion: envelope.keyVersion,
    elementCount: nextState.elementCount,
    recordCount: nextState.recordCount,
    chainHead: nextState.chainHead,
    generation: nextState.generation,
    manifestKey: plan.manifestKey,
    manifestHeadPageKey: plan.manifestHeadPageKey,
    newElements: ledgerElements,
    ranges: Object.fromEntries(
      plan.chunks.flatMap((chunk) =>
        [...chunk.ranges].map(([sequence, range]) => [String(sequence), range]),
      ),
    ),
    scan: {
      partId: upload.checkpoint.source_transcript_part_id,
      checkpoint: upload.checkpoint,
      fingerprints: sourceFingerprints(upload.observations),
      replace: !upload.isDelta,
    },
  };
  const expectedObjects = [
    ...plan.chunks.map((chunk) => ({
      key: chunk.objectKey,
      body: chunk.encryptedBody,
      objectClass: 'chunk' as const,
      plaintext: chunk.plainBytes,
    })),
    ...plan.manifestObjects,
  ];
  if (priorIntent) {
    assertPendingIntentMatches(priorIntent, expectedObjects);
    await verifyPendingIntentBodies(
      priorIntent.objects,
      expectedObjects,
      archiveKey,
      envelope.scope.orgId,
      envelope.keyVersion,
    );
    await verifyObjects(env.ARCHIVE_STORAGE, priorIntent.objects);
    if (priorIntent.status === 'building') markIntentReady(storage, intentHash);
    commitIntent(storage, intentHash, commit, priorIntent.acknowledgement);
    return priorIntent.acknowledgement;
  }
  writeIntent(storage, intent);
  markIntentReady(storage, intentHash);
  await verifyObjects(env.ARCHIVE_STORAGE, objects);
  commitIntent(storage, intentHash, commit, acknowledgement);
  return acknowledgement;
}

function assertPendingIntentMatches(
  intent: PendingIntent,
  expected: { key: string; objectClass: ArchiveR2Object['objectClass'] }[],
): void {
  const actual = intent.objects.map(({ key, objectClass }) => ({ key, objectClass }));
  const expectedDescriptors = expected.map(({ key, objectClass }) => ({ key, objectClass }));
  if (JSON.stringify(actual) !== JSON.stringify(expectedDescriptors)) {
    throw new ArchiveContractError('pending_intent_mismatch');
  }
}

async function verifyPendingIntentBodies(
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

async function unwrapKey(
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
  for (const object of objects) await verifyOrPutImmutableObject(bucket, object);
}

function assertScope(state: LedgerSnapshot, scope: ArchiveScope): LedgerSnapshot {
  if (!state.scope) return { ...state, scope };
  if (JSON.stringify(state.scope) !== JSON.stringify(scope)) {
    throw new ArchiveContractError('ledger_scope_mismatch');
  }
  return state;
}
