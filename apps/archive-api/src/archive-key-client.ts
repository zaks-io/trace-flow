import type { Logger } from '@trace-flow/logging';
import { parseArchiveWrappedKeyVersion } from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import type { ArchiveWrappedKey } from './enrollment';

const POLICY_TIMEOUT_MS = 5000;

export interface ArchiveActiveKey extends ArchiveWrappedKey {
  retiringKeyVersion?: number;
  rotationOperationId?: string;
  rotationStatus?: 'rotating' | 'succeeded' | 'failed';
}

export interface ArchiveKeyActivation {
  orgId: string;
  fromVersion: number;
  toVersion: number;
  replay: boolean;
  activationId?: string;
  operationId: string;
}

async function postConvex<T>(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  path: string,
  body: unknown,
): Promise<{ status: number; payload: T }> {
  const response = await fetch(`${env.CONVEX_SITE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, payload };
}

function isWrappedKey(value: unknown, expectedVersion?: number): value is ArchiveWrappedKey {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.wrappedKey === 'string' &&
    typeof record.keyVersion === 'number' &&
    Number.isSafeInteger(record.keyVersion) &&
    record.keyVersion >= 1 &&
    (expectedVersion === undefined || record.keyVersion === expectedVersion)
  );
}

export async function getArchiveWrappedKeyVersion(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: { orgId: string; keyVersion: number },
  logger: Logger,
): Promise<ArchiveWrappedKey> {
  try {
    const { status, payload } = await postConvex<Record<string, unknown>>(
      env,
      '/archive-api/key',
      input,
    );
    if (status === 404) throw new ArchiveContractError('key_unavailable');
    if (status >= 400 || !isWrappedKey(payload, input.keyVersion)) {
      logger.error('archive_api.key_fetch_failed', undefined, { status });
      throw new ArchiveContractError('key_unavailable');
    }
    parseArchiveWrappedKeyVersion(payload.wrappedKey, input);
    return { keyVersion: input.keyVersion, wrappedKey: payload.wrappedKey };
  } catch (error) {
    if (error instanceof ArchiveContractError) throw error;
    logger.error('archive_api.key_fetch_error', error);
    throw new ArchiveContractError('key_unavailable');
  }
}

export async function getActiveArchiveWrappedKey(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  orgId: string,
  logger: Logger,
): Promise<ArchiveActiveKey | null> {
  try {
    const { status, payload } = await postConvex<Record<string, unknown>>(
      env,
      '/archive-api/key/active',
      { orgId },
    );
    if (status === 404) return null;
    if (status >= 400 || !isWrappedKey(payload)) {
      logger.error('archive_api.active_key_fetch_failed', undefined, { status });
      throw new ArchiveContractError('key_unavailable');
    }
    parseArchiveWrappedKeyVersion(payload.wrappedKey, {
      orgId,
      keyVersion: payload.keyVersion,
    });
    return {
      keyVersion: payload.keyVersion,
      wrappedKey: payload.wrappedKey,
      ...(typeof payload.retiringKeyVersion === 'number'
        ? { retiringKeyVersion: payload.retiringKeyVersion }
        : {}),
      ...(typeof payload.rotationOperationId === 'string'
        ? { rotationOperationId: payload.rotationOperationId }
        : {}),
      ...(payload.rotationStatus === 'rotating' ||
      payload.rotationStatus === 'succeeded' ||
      payload.rotationStatus === 'failed'
        ? { rotationStatus: payload.rotationStatus }
        : {}),
    };
  } catch (error) {
    if (error instanceof ArchiveContractError) throw error;
    logger.error('archive_api.active_key_fetch_error', error);
    throw new ArchiveContractError('key_unavailable');
  }
}

export async function activateArchiveKeyVersion(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: { orgId: string; keyVersion: number; wrappedKey: string; operationId: string },
  logger: Logger,
): Promise<ArchiveKeyActivation> {
  const { status, payload } = await postConvex<Record<string, unknown>>(
    env,
    '/archive-api/key/activate',
    input,
  );
  if (
    status >= 400 ||
    typeof payload.fromVersion !== 'number' ||
    typeof payload.toVersion !== 'number' ||
    typeof payload.replay !== 'boolean' ||
    typeof payload.operationId !== 'string'
  ) {
    logger.error('archive_api.key_activate_failed', undefined, { status });
    throw new ArchiveContractError('archive_key_activation_failed');
  }
  return {
    orgId: input.orgId,
    fromVersion: payload.fromVersion,
    toVersion: payload.toVersion,
    replay: payload.replay,
    operationId: payload.operationId,
    ...(typeof payload.activationId === 'string' ? { activationId: payload.activationId } : {}),
  };
}

export async function destroyRetiringArchiveKey(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: {
    orgId: string;
    keyVersion: number;
    operationId: string;
    liveReferenceCount: number;
  },
  logger: Logger,
): Promise<boolean> {
  const { status, payload } = await postConvex<{ destroyed?: unknown; error?: unknown }>(
    env,
    '/archive-api/key/destroy-retiring',
    input,
  );
  if (status === 409) {
    throw new ArchiveContractError(
      typeof payload.error === 'string' && payload.error.includes('live object references')
        ? 'archive_key_has_live_references'
        : 'archive_key_destroy_rejected',
    );
  }
  if (status >= 400 || typeof payload.destroyed !== 'boolean') {
    logger.error('archive_api.key_destroy_failed', undefined, { status });
    throw new ArchiveContractError('archive_key_destroy_failed');
  }
  return payload.destroyed;
}

export async function markArchiveKeyRotationFailed(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: { orgId: string; operationId: string },
  logger: Logger,
): Promise<void> {
  const { status } = await postConvex(env, '/archive-api/key/rotation-failed', input);
  if (status >= 400) {
    logger.error('archive_api.key_rotation_failure_record_failed', undefined, { status });
    throw new ArchiveContractError('archive_key_rotation_failure_unrecorded');
  }
}
