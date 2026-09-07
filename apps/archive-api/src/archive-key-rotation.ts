import {
  createArchiveEncryptionKeyVersion,
  serializeArchiveWrappedKeyVersion,
} from '@trace-flow/utils';
import type { Logger } from '@trace-flow/logging';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import {
  activateArchiveKeyVersion,
  destroyRetiringArchiveKey,
  getActiveArchiveWrappedKey,
  getArchiveWrappedKeyVersion,
  markArchiveKeyRotationFailed,
  type ArchiveKeyActivation,
} from './archive-key-client';
import { appendArchiveAuditEvent } from './audit';
import {
  ARCHIVE_ROTATION_PAGE_LIMIT,
  assertCurrentRotation,
  countKeyVersionReferences,
  listCommittedObjectsForRotation,
  readRotationState,
  rotationHealth,
  writeRotationState,
  type ArchiveKeyRotationFailureInjection,
  type ArchiveKeyRotationHealth,
  type ArchiveKeyRotationState,
  type ArchiveKeyRotationFence,
} from './archive-key-rotation-state';
import { reencryptArchiveObject } from './archive-key-reencryption';

export { ARCHIVE_ROTATION_TEMP_SUFFIX } from './archive-key-rotation-state';
export { commitRotationReplacement } from './archive-key-reencryption';

export function startStoredRotation(
  storage: DurableObjectStorage,
  input: {
    operationId: string;
    fromVersion: number;
    toVersion: number;
    activationId?: string;
  },
): ArchiveKeyRotationState {
  const existing = readRotationState(storage);
  if (
    existing?.operationId === input.operationId &&
    existing.fromVersion === input.fromVersion &&
    existing.toVersion === input.toVersion
  ) {
    return existing;
  }
  if (existing && existing.status !== 'succeeded' && existing.status !== 'failed') {
    if (existing.operationId !== input.operationId) {
      throw new ArchiveContractError('archive_key_rotation_in_progress');
    }
    return existing;
  }
  const next: ArchiveKeyRotationState = {
    operationId: input.operationId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    status: 'reencrypting',
    generation:
      existing?.operationId === input.operationId
        ? existing.generation
        : (existing?.generation ?? 0) + 1,
    reencryptedCount: existing?.operationId === input.operationId ? existing.reencryptedCount : 0,
    remainingReferences: countKeyVersionReferences(storage, input.fromVersion),
    activationId: input.activationId,
    manifestRootHashes:
      existing?.operationId === input.operationId ? existing.manifestRootHashes : [],
    updatedAt: Date.now(),
  };
  writeRotationState(storage, next);
  return next;
}

function rememberManifestRoot(state: ArchiveKeyRotationState, objectKey: string): void {
  const digest = /\/manifests\/([0-9a-f]{64})$/.exec(objectKey)?.[1];
  if (!digest || state.manifestRootHashes.includes(digest)) return;
  state.manifestRootHashes = [...state.manifestRootHashes, digest].slice(0, 32);
}

async function completeDestroyingRotation(
  storage: DurableObjectStorage,
  env: ArchiveApiEnv,
  logger: Logger,
  orgId: string,
  state: ArchiveKeyRotationState,
  fence: ArchiveKeyRotationFence,
  injectFailure?: ArchiveKeyRotationFailureInjection,
): Promise<ArchiveKeyRotationHealth> {
  const persist = (): void => {
    assertCurrentRotation(storage, fence);
    writeRotationState(storage, state);
  };
  state.remainingReferences = countKeyVersionReferences(storage, state.fromVersion);
  if (state.remainingReferences > 0) {
    state.status = 'reencrypting';
    state.updatedAt = Date.now();
    persist();
    return rotationHealth(orgId, state);
  }
  await destroyRetiringArchiveKey(
    env,
    {
      orgId,
      keyVersion: state.fromVersion,
      operationId: state.operationId,
      liveReferenceCount: state.remainingReferences,
    },
    logger,
  );
  if (injectFailure === 'after_destroy') {
    throw new ArchiveContractError('rotation_failure_injected');
  }
  state.status = 'succeeded';
  state.remainingReferences = 0;
  state.lastErrorClass = undefined;
  state.updatedAt = Date.now();
  persist();
  try {
    await publishRotationAudit(env, logger, orgId, state, 'success');
  } catch (error) {
    logger.error('archive_api.key_rotation_audit_failed', error, { outcome: 'success' });
  }
  return rotationHealth(orgId, state);
}

export async function advanceStoredRotation(
  storage: DurableObjectStorage,
  env: ArchiveApiEnv,
  logger: Logger,
  input: {
    orgId: string;
    limit?: number;
    injectFailure?: ArchiveKeyRotationFailureInjection;
  },
): Promise<ArchiveKeyRotationHealth> {
  let state = readRotationState(storage);
  if (!state) return rotationHealth(input.orgId, null);
  if (state.status === 'succeeded') {
    return rotationHealth(input.orgId, state);
  }
  const fence: ArchiveKeyRotationFence = {
    operationId: state.operationId,
    generation: state.generation,
    fromVersion: state.fromVersion,
    toVersion: state.toVersion,
  };
  const persist = (): void => {
    assertCurrentRotation(storage, fence);
    writeRotationState(storage, state!);
  };
  if (state.status === 'failed') {
    const resumeStatus =
      countKeyVersionReferences(storage, state.fromVersion) === 0 ? 'destroying' : 'reencrypting';
    state = { ...state, status: resumeStatus, lastErrorClass: undefined, updatedAt: Date.now() };
    persist();
  }

  try {
    if (state.status === 'destroying') {
      return await completeDestroyingRotation(
        storage,
        env,
        logger,
        input.orgId,
        state,
        fence,
        input.injectFailure,
      );
    }

    const fromKey = await getArchiveWrappedKeyVersion(
      env,
      { orgId: input.orgId, keyVersion: state.fromVersion },
      logger,
    );
    const toKey = await getArchiveWrappedKeyVersion(
      env,
      { orgId: input.orgId, keyVersion: state.toVersion },
      logger,
    );
    const limit = Math.min(Math.max(input.limit ?? ARCHIVE_ROTATION_PAGE_LIMIT, 1), 32);
    const page = listCommittedObjectsForRotation(storage, state.fromVersion, state.cursor, limit);

    for (const object of page) {
      const result = await reencryptArchiveObject(env, storage, {
        orgId: input.orgId,
        objectKey: object.objectKey,
        objectClass: object.objectClass,
        operationId: state.operationId,
        generation: state.generation,
        fromVersion: state.fromVersion,
        toVersion: state.toVersion,
        fromWrappedKey: fromKey.wrappedKey,
        toWrappedKey: toKey.wrappedKey,
        injectFailure: input.injectFailure,
      });
      if (result === 'rotated' || result === 'already') {
        state.reencryptedCount += 1;
        rememberManifestRoot(state, object.objectKey);
      }
      state.cursor = object.objectKey;
      state.remainingReferences = countKeyVersionReferences(storage, state.fromVersion);
      state.updatedAt = Date.now();
      persist();
    }

    if (page.length === limit) {
      state.status = 'reencrypting';
      state.updatedAt = Date.now();
      persist();
      return rotationHealth(input.orgId, state);
    }

    state.remainingReferences = countKeyVersionReferences(storage, state.fromVersion);
    if (state.remainingReferences > 0) {
      state.status = 'reencrypting';
      state.cursor = undefined;
      state.updatedAt = Date.now();
      persist();
      return rotationHealth(input.orgId, state);
    }

    state.status = 'destroying';
    state.cursor = undefined;
    state.updatedAt = Date.now();
    persist();
    return await completeDestroyingRotation(
      storage,
      env,
      logger,
      input.orgId,
      state,
      fence,
      input.injectFailure,
    );
  } catch (error) {
    if (state.status === 'succeeded') throw error;
    const errorClass =
      error instanceof ArchiveContractError ? error.errorClass : 'archive_key_rotation_failed';
    state.remainingReferences = countKeyVersionReferences(storage, state.fromVersion);
    state.lastErrorClass = errorClass;
    state.updatedAt = Date.now();
    if (errorClass === 'rotation_failure_injected') {
      if (state.status !== 'destroying') state.status = 'reencrypting';
      persist();
      throw error;
    }
    state.status = 'failed';
    persist();
    await markArchiveKeyRotationFailed(
      env,
      { orgId: input.orgId, operationId: state.operationId },
      logger,
    ).catch(() => undefined);
    await publishRotationAudit(env, logger, input.orgId, state, 'failure').catch(() => undefined);
    throw error;
  }
}

async function publishRotationAudit(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  logger: Logger,
  orgId: string,
  state: ArchiveKeyRotationState,
  outcome: 'success' | 'failure',
): Promise<void> {
  if (!state.activationId) return;
  await appendArchiveAuditEvent(
    env,
    {
      binding: { kind: 'activation', activationId: state.activationId },
      expectedOrgId: orgId,
      action: 'key_rotation',
      outcome,
      operationId: `${state.operationId}:${outcome}`,
      targetKind: 'encryption_key',
      targetId: String(state.toVersion),
      relevantCount: state.reencryptedCount,
      ...(state.manifestRootHashes[0] ? { manifestRootHash: state.manifestRootHashes[0] } : {}),
    },
    logger,
  );
}

export async function mintAndActivateNextKey(
  env: ArchiveApiEnv,
  orgId: string,
  logger: Logger,
  operationId?: string,
): Promise<ArchiveKeyActivation> {
  const active = await getActiveArchiveWrappedKey(env, orgId, logger);
  if (!active) throw new ArchiveContractError('key_unavailable');
  if (
    active.retiringKeyVersion !== undefined &&
    (active.rotationStatus === 'rotating' || active.rotationStatus === 'failed')
  ) {
    return {
      orgId,
      fromVersion: active.retiringKeyVersion,
      toVersion: active.keyVersion,
      replay: true,
      operationId:
        operationId ??
        active.rotationOperationId ??
        `key-rotation:${orgId}:${active.retiringKeyVersion}:${active.keyVersion}`,
    };
  }
  const nextVersion = active.keyVersion + 1;
  const resolvedOperationId =
    operationId ?? `key-rotation:${orgId}:${active.keyVersion}:${nextVersion}`;
  if (active.rotationOperationId === resolvedOperationId) {
    const completedFromVersion = active.retiringKeyVersion ?? Math.max(active.keyVersion - 1, 1);
    return {
      orgId,
      fromVersion: completedFromVersion,
      toVersion: active.keyVersion,
      replay: true,
      operationId: resolvedOperationId,
    };
  }
  const wrapped = await createArchiveEncryptionKeyVersion({
    orgId,
    keyVersion: nextVersion,
    wrappingSecretBase64: env.ARCHIVE_KEY_WRAPPING_SECRET,
  });
  return activateArchiveKeyVersion(
    env,
    {
      orgId,
      keyVersion: nextVersion,
      wrappedKey: serializeArchiveWrappedKeyVersion(wrapped),
      operationId: resolvedOperationId,
    },
    logger,
  );
}
