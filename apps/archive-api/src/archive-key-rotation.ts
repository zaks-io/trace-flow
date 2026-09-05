import {
  createArchiveEncryptionKeyVersion,
  decryptArchiveObject,
  encryptArchiveObject,
  parseArchiveWrappedKeyVersion,
  serializeArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
  type ArchiveObjectEnvelope,
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
  countKeyVersionReferences,
  listCommittedObjectsForRotation,
  readRotationState,
  recordRotatedObject,
  rotationHealth,
  rotationTempObjectKey,
  writeRotationState,
  type ArchiveKeyRotationFailureInjection,
  type ArchiveKeyRotationHealth,
  type ArchiveKeyRotationState,
} from './archive-key-rotation-state';

export { ARCHIVE_ROTATION_TEMP_SUFFIX } from './archive-key-rotation-state';

function objectClassFromBudget(
  value: 'agent_archive_chunk' | 'agent_archive_manifest',
): 'chunk' | 'manifest' {
  return value === 'agent_archive_chunk' ? 'chunk' : 'manifest';
}

function parseEnvelope(body: string): ArchiveObjectEnvelope {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ArchiveContractError('archive_object_envelope_invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (
    (record.objectClass !== 'chunk' && record.objectClass !== 'manifest') ||
    typeof record.objectKey !== 'string' ||
    typeof record.orgId !== 'string' ||
    typeof record.keyVersion !== 'number'
  ) {
    throw new ArchiveContractError('archive_object_envelope_invalid');
  }
  return parsed as ArchiveObjectEnvelope;
}

async function unwrapVersion(
  env: Pick<ArchiveApiEnv, 'ARCHIVE_KEY_WRAPPING_SECRET'>,
  orgId: string,
  keyVersion: number,
  wrappedKey: string,
): Promise<CryptoKey> {
  return unwrapArchiveEncryptionKey(
    parseArchiveWrappedKeyVersion(wrappedKey, { orgId, keyVersion }),
    {
      orgId,
      keyVersion,
      wrappingSecretBase64: env.ARCHIVE_KEY_WRAPPING_SECRET,
    },
  );
}

async function readObjectBody(bucket: R2Bucket, objectKey: string): Promise<string | null> {
  const object = await bucket.get(objectKey);
  return object ? await object.text() : null;
}

async function putEncryptedObject(
  bucket: R2Bucket,
  objectKey: string,
  body: string,
): Promise<void> {
  await bucket.put(objectKey, body, {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function reencryptArchiveObject(
  env: Pick<ArchiveApiEnv, 'ARCHIVE_STORAGE' | 'ARCHIVE_KEY_WRAPPING_SECRET'>,
  storage: DurableObjectStorage,
  input: {
    orgId: string;
    objectKey: string;
    objectClass: 'agent_archive_chunk' | 'agent_archive_manifest';
    fromVersion: number;
    toVersion: number;
    fromWrappedKey: string;
    toWrappedKey: string;
    injectFailure?: ArchiveKeyRotationFailureInjection;
  },
): Promise<'rotated' | 'already'> {
  const expectedClass = objectClassFromBudget(input.objectClass);
  const canonical = await readObjectBody(env.ARCHIVE_STORAGE, input.objectKey);
  if (canonical === null) throw new ArchiveContractError('rotation_object_missing');
  const envelope = parseEnvelope(canonical);
  if (envelope.objectKey !== input.objectKey || envelope.orgId !== input.orgId) {
    throw new ArchiveContractError('archive_object_envelope_invalid');
  }
  if (envelope.objectClass !== expectedClass) {
    throw new ArchiveContractError('archive_object_envelope_invalid');
  }

  if (envelope.keyVersion === input.toVersion) {
    recordRotatedObject(
      storage,
      input.objectKey,
      input.toVersion,
      new TextEncoder().encode(canonical).byteLength,
    );
    await env.ARCHIVE_STORAGE.delete(rotationTempObjectKey(input.objectKey));
    return 'already';
  }
  if (envelope.keyVersion !== input.fromVersion) {
    throw new ArchiveContractError('archive_key_version_mismatch');
  }

  const fromKey = await unwrapVersion(env, input.orgId, input.fromVersion, input.fromWrappedKey);
  const toKey = await unwrapVersion(env, input.orgId, input.toVersion, input.toWrappedKey);
  const plaintext = await decryptArchiveObject(envelope, {
    key: fromKey,
    orgId: input.orgId,
    objectKey: input.objectKey,
    objectClass: expectedClass,
    keyVersion: input.fromVersion,
  });

  let replacementBody: string;
  try {
    const replacement = await encryptArchiveObject(plaintext, {
      key: toKey,
      orgId: input.orgId,
      objectKey: input.objectKey,
      objectClass: expectedClass,
      keyVersion: input.toVersion,
    });
    replacementBody = JSON.stringify(replacement);
  } finally {
    plaintext.fill(0);
  }

  const tempKey = rotationTempObjectKey(input.objectKey);
  await putEncryptedObject(env.ARCHIVE_STORAGE, tempKey, replacementBody);
  const tempBody = await readObjectBody(env.ARCHIVE_STORAGE, tempKey);
  if (tempBody !== replacementBody) {
    throw new ArchiveContractError('r2_object_verification_failed');
  }
  await decryptArchiveObject(parseEnvelope(replacementBody), {
    key: toKey,
    orgId: input.orgId,
    objectKey: input.objectKey,
    objectClass: expectedClass,
    keyVersion: input.toVersion,
  });
  if (input.injectFailure === 'before_replace') {
    throw new ArchiveContractError('rotation_failure_injected');
  }

  await putEncryptedObject(env.ARCHIVE_STORAGE, input.objectKey, replacementBody);
  const replaced = await readObjectBody(env.ARCHIVE_STORAGE, input.objectKey);
  if (replaced !== replacementBody) {
    throw new ArchiveContractError('r2_object_verification_failed');
  }
  await decryptArchiveObject(parseEnvelope(replaced), {
    key: toKey,
    orgId: input.orgId,
    objectKey: input.objectKey,
    objectClass: expectedClass,
    keyVersion: input.toVersion,
  });
  if (input.injectFailure === 'after_replace') {
    throw new ArchiveContractError('rotation_failure_injected');
  }

  await env.ARCHIVE_STORAGE.delete(tempKey);
  recordRotatedObject(
    storage,
    input.objectKey,
    input.toVersion,
    new TextEncoder().encode(replacementBody).byteLength,
  );
  return 'rotated';
}

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
  if (state.status === 'failed') {
    state = { ...state, status: 'reencrypting', lastErrorClass: undefined, updatedAt: Date.now() };
    writeRotationState(storage, state);
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

  try {
    for (const object of page) {
      const result = await reencryptArchiveObject(env, storage, {
        orgId: input.orgId,
        objectKey: object.objectKey,
        objectClass: object.objectClass,
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
      writeRotationState(storage, state);
    }

    if (page.length === limit) {
      state.status = 'reencrypting';
      state.updatedAt = Date.now();
      writeRotationState(storage, state);
      return rotationHealth(input.orgId, state);
    }

    state.remainingReferences = countKeyVersionReferences(storage, state.fromVersion);
    if (state.remainingReferences > 0) {
      state.status = 'reencrypting';
      state.cursor = undefined;
      state.updatedAt = Date.now();
      writeRotationState(storage, state);
      return rotationHealth(input.orgId, state);
    }

    state.status = 'destroying';
    state.cursor = undefined;
    state.updatedAt = Date.now();
    writeRotationState(storage, state);

    await destroyRetiringArchiveKey(
      env,
      {
        orgId: input.orgId,
        keyVersion: state.fromVersion,
        operationId: state.operationId,
        liveReferenceCount: state.remainingReferences,
      },
      logger,
    );
    state.status = 'succeeded';
    state.remainingReferences = 0;
    state.lastErrorClass = undefined;
    state.updatedAt = Date.now();
    writeRotationState(storage, state);
    await publishRotationAudit(env, logger, input.orgId, state, 'success');
    return rotationHealth(input.orgId, state);
  } catch (error) {
    const errorClass =
      error instanceof ArchiveContractError ? error.errorClass : 'archive_key_rotation_failed';
    state.remainingReferences = countKeyVersionReferences(storage, state.fromVersion);
    state.lastErrorClass = errorClass;
    state.updatedAt = Date.now();
    if (errorClass === 'rotation_failure_injected') {
      state.status = 'reencrypting';
      writeRotationState(storage, state);
      throw error;
    }
    state.status = 'failed';
    writeRotationState(storage, state);
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
  if (active.rotationStatus === 'rotating' && active.retiringKeyVersion !== undefined) {
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
