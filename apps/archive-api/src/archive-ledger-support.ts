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
  if (
    errorClass === 'duplicate_record_version' ||
    errorClass === 'checkpoint_regressed' ||
    errorClass.includes('historical') ||
    errorClass.includes('chain') ||
    errorClass.includes('immutable') ||
    errorClass.includes('verification')
  ) {
    return 409;
  }
  if (errorClass.includes('key_unavailable') || errorClass === 'pending_commit_exists') return 503;
  if (errorClass === 'archive_commit_failed') return 500;
  return 400;
}
