import { parseArchiveWrappedKeyVersion } from '@trace-flow/utils';
import {
  ArchiveContractError,
  assertIdentifier,
  type ArchiveScope,
  type ArchiveUploadRequest,
} from './archive-contract';
import type {
  ArchiveAcknowledgement,
  CommitEnvelope,
  LedgerSnapshot,
} from './archive-ledger-state';

export function parseCommitEnvelope(value: unknown): CommitEnvelope {
  if (typeof value !== 'object' || value === null) throw new ArchiveContractError('invalid_commit');
  const record = value as Record<string, unknown>;
  if (typeof record.scope !== 'object' || record.scope === null) {
    throw new ArchiveContractError('invalid_scope');
  }
  const scope = record.scope as Record<string, unknown>;
  for (const field of ['orgId', 'userId', 'contributionId', 'sourceSessionId']) {
    assertIdentifier(scope[field], 'invalid_scope');
  }
  if (scope.source !== 'claude' && scope.source !== 'codex') {
    throw new ArchiveContractError('invalid_scope');
  }
  if (typeof record.upload !== 'object' || record.upload === null) {
    throw new ArchiveContractError('invalid_upload');
  }
  if (typeof record.wrappedKey !== 'string') {
    throw new ArchiveContractError('missing_archive_key');
  }
  if (!Number.isSafeInteger(record.keyVersion) || (record.keyVersion as number) < 1) {
    throw new ArchiveContractError('invalid_archive_key_version');
  }
  parseArchiveWrappedKeyVersion(record.wrappedKey, {
    orgId: scope.orgId as string,
    keyVersion: record.keyVersion as number,
  });
  const parsedScope: ArchiveScope = {
    orgId: scope.orgId as string,
    userId: scope.userId as string,
    contributionId: scope.contributionId as string,
    source: scope.source,
    sourceSessionId: scope.sourceSessionId as string,
  };
  return {
    scope: parsedScope,
    upload: record.upload as ArchiveUploadRequest,
    keyVersion: record.keyVersion as number,
    wrappedKey: record.wrappedKey,
  };
}

export async function intentDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function buildAcknowledgement(
  state: LedgerSnapshot,
  duplicate: boolean,
  appendedRecords: number,
  appendedCheckpoint: boolean,
  chunkKeys: string[],
): ArchiveAcknowledgement {
  if (!state.manifestKey || !state.scope) throw new ArchiveContractError('manifest_ack_missing');
  return {
    status: 'acknowledged',
    duplicate,
    source: state.scope.source,
    source_session_id: state.scope.sourceSessionId,
    contribution_id: state.scope.contributionId,
    appended_records: appendedRecords,
    appended_checkpoint: appendedCheckpoint,
    record_count: state.recordCount,
    generation: state.generation,
    chain_head: state.chainHead,
    manifest_key: state.manifestKey,
    chunk_keys: chunkKeys,
  };
}

export function statusFor(errorClass: string): number {
  if (
    errorClass === 'archive_element_exceeds_chunk_limit' ||
    errorClass === 'archive_commit_too_large' ||
    errorClass === 'archive_upload_observation_limit'
  )
    return 413;
  if (CONFLICT_ERROR_CLASSES.has(errorClass)) return 409;
  if (errorClass === 'storage_cap_exceeded') return 507;
  if (TRANSIENT_ERROR_CLASSES.has(errorClass)) return 503;
  if (errorClass === 'archive_commit_failed') return 500;
  return 400;
}

const CONFLICT_ERROR_CLASSES = new Set([
  'duplicate_record_version',
  'checkpoint_regressed',
  'missing_historical_prefix_proof',
  'historical_prefix_changed',
  'unexpected_historical_prefix_proof',
  'immutable_object_collision',
  'r2_object_verification_failed',
  'compressed_chunk_verification_failed',
  'manifest_encryption_verification_failed',
  'pending_intent_corrupt',
  'pending_intent_mismatch',
  'pending_intent_head_mismatch',
  'pending_object_verification_failed',
  'ledger_state_corrupt',
  'storage_object_metadata_mismatch',
  'storage_reservation_missing',
  'storage_budget_identity_mismatch',
  'storage_budget_corrupt',
  'archive_key_has_live_references',
  'archive_key_destroy_rejected',
  'archive_key_rotation_in_progress',
  'archive_key_version_retired',
]);

const TRANSIENT_ERROR_CLASSES = new Set([
  'key_unavailable',
  'pending_commit_exists',
  'storage_budget_inventory_failed',
  'archive_key_activation_failed',
  'archive_key_rotation_failed',
]);
