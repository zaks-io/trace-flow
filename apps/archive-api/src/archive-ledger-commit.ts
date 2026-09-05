import type { ArchiveApiEnv } from './context';
import { ArchiveContractError, type ArchiveScope } from './archive-contract';
import { packNewElementsPaged } from './archive-packing';
import {
  assertIncomingObservationCount,
  parseAndValidateUpload,
  sourceFingerprints,
} from './archive-validation';
import {
  storageBudgetObject,
  verifyEncryptedPlannedObject,
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
  discardPendingIntent,
  readIntent,
  readPendingIntent,
  markIntentReady,
  writeIntent,
  assertPendingIntentAuthenticated,
  encryptPendingIntentState,
  pendingIntentStateHash,
  type PendingIntent,
} from './archive-ledger-intent';
import { reconcileArchiveUpload } from './archive-ledger-reconciliation';
import { buildAcknowledgement, intentDigest, parseCommitEnvelope } from './archive-ledger-support';
import {
  assertPendingIntentMatches,
  pendingExpectedObjects,
  recoverPendingIntent,
  unwrapKey,
  verifyObjectsAndReleaseDefinitivelyUnwritten,
  verifyPendingIntentBodies,
} from './archive-ledger-intent-recovery';

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
  let scan = readLedgerScan(storage, upload.checkpoint.source_transcript_part_id);
  const configuredKeyVersion = Number(env.ARCHIVE_KEY_VERSION);
  if (envelope.keyVersion !== configuredKeyVersion) {
    throw new ArchiveContractError('archive_key_version_mismatch');
  }
  if (state.keyVersion !== undefined && state.keyVersion !== envelope.keyVersion) {
    throw new ArchiveContractError('archive_key_version_mismatch');
  }

  const intentHash = await intentDigest({ scope: envelope.scope, upload });
  const priorIntent = readIntent(storage, intentHash);
  const budget = env.STORAGE_BUDGET.getByName(envelope.scope.orgId);
  if (priorIntent?.status === 'committed') {
    await budget.recordArchiveAcknowledgement({
      orgId: envelope.scope.orgId,
      acknowledgedAt: Date.now(),
    });
    return priorIntent.acknowledgement;
  }
  const existingPending = readPendingIntent(storage);
  if (existingPending && existingPending.intentHash !== intentHash) {
    await recoverPendingIntent(storage, env, envelope, state, existingPending);
    state = assertScope(readLedgerSnapshot(storage), envelope.scope);
    scan = readLedgerScan(storage, upload.checkpoint.source_transcript_part_id);
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
  const expectedPendingObjects = pendingExpectedObjects(expectedObjects);
  const stateHash = await pendingIntentStateHash(intentHash, commit, expectedPendingObjects);
  const stateAuthentication = await encryptPendingIntentState(
    intentHash,
    commit,
    expectedPendingObjects,
    archiveKey,
    envelope.scope.orgId,
    envelope.keyVersion,
  );
  if (priorIntent) {
    await assertPendingIntentAuthenticated({
      ...priorIntent,
      key: archiveKey,
      orgId: envelope.scope.orgId,
      keyVersion: envelope.keyVersion,
    });
    assertPendingIntentMatches(priorIntent, expectedObjects);
    if (stateHash !== priorIntent.stateHash) {
      throw new ArchiveContractError('pending_intent_mismatch');
    }
    await verifyPendingIntentBodies(
      priorIntent.objects,
      expectedObjects,
      archiveKey,
      envelope.scope.orgId,
      envelope.keyVersion,
    );
    const reservation = await budget.reserveStorage({
      orgId: envelope.scope.orgId,
      objects: priorIntent.objects.map(storageBudgetObject),
    });
    if (!reservation.accepted) throw new ArchiveContractError('storage_cap_exceeded');
    await verifyObjectsAndReleaseDefinitivelyUnwritten(
      env.ARCHIVE_STORAGE,
      priorIntent.objects,
      (unwritten) =>
        budget.releaseStorage({
          orgId: envelope.scope.orgId,
          objects: unwritten.map(storageBudgetObject),
        }),
    );
    await budget.commitStorage({
      orgId: envelope.scope.orgId,
      objects: priorIntent.objects.map(storageBudgetObject),
    });
    if (priorIntent.status === 'building') markIntentReady(storage, intentHash);
    commitIntent(storage, intentHash, priorIntent.commit!, priorIntent.acknowledgement);
    await budget.recordArchiveAcknowledgement({
      orgId: envelope.scope.orgId,
      acknowledgedAt: Date.now(),
    });
    return priorIntent.acknowledgement;
  }
  const intent: PendingIntent = {
    intentHash,
    status: 'building',
    baseElementCount: state.elementCount,
    baseChainHead: state.chainHead,
    objects,
    acknowledgement,
    commit,
    stateHash,
    stateAuthentication,
  };
  writeIntent(storage, intent);
  markIntentReady(storage, intentHash);
  const reservation = await budget.reserveStorage({
    orgId: envelope.scope.orgId,
    objects: objects.map(storageBudgetObject),
  });
  if (!reservation.accepted) {
    discardPendingIntent(storage, intentHash);
    throw new ArchiveContractError('storage_cap_exceeded');
  }
  await verifyObjectsAndReleaseDefinitivelyUnwritten(env.ARCHIVE_STORAGE, objects, (unwritten) =>
    budget.releaseStorage({
      orgId: envelope.scope.orgId,
      objects: unwritten.map(storageBudgetObject),
    }),
  );
  await budget.commitStorage({
    orgId: envelope.scope.orgId,
    objects: objects.map(storageBudgetObject),
  });
  commitIntent(storage, intentHash, commit, acknowledgement);
  await budget.recordArchiveAcknowledgement({
    orgId: envelope.scope.orgId,
    acknowledgedAt: Date.now(),
  });
  return acknowledgement;
}

function assertScope(state: LedgerSnapshot, scope: ArchiveScope): LedgerSnapshot {
  if (!state.scope) return { ...state, scope };
  if (JSON.stringify(state.scope) !== JSON.stringify(scope)) {
    throw new ArchiveContractError('ledger_scope_mismatch');
  }
  return state;
}
