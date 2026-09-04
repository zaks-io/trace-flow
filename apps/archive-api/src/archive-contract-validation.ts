import {
  ARCHIVE_FORMAT_VERSION,
  ArchiveContractError,
  CHAIN_HASH_VERSION,
  type ArchiveObservation,
  type ArchiveSource,
  type CompletedScanCheckpoint,
  type StoredRecordMetadata,
  assertArchiveSource,
  assertDigest,
  assertIdentifier,
  assertSafeInteger,
  assertTranscriptPartId,
  assertVersion,
  digestString,
  payloadBytes,
} from './archive-contract';

export async function validateObservation(
  value: unknown,
  expected: { source: ArchiveSource; sourceSessionId: string },
): Promise<ArchiveObservation> {
  if (typeof value !== 'object' || value === null) {
    throw new ArchiveContractError('invalid_observation');
  }
  const observation = value as Record<string, unknown>;
  assertVersion(
    observation.archive_format_version,
    ARCHIVE_FORMAT_VERSION,
    'unsupported_archive_format_version',
  );
  assertVersion(
    observation.chain_hash_version,
    CHAIN_HASH_VERSION,
    'unsupported_chain_hash_version',
  );
  assertArchiveSource(observation.source);
  assertIdentifier(observation.source_session_id, 'invalid_source_session_id');
  assertIdentifier(observation.source_transcript_part_id, 'invalid_transcript_part_id');
  assertTranscriptPartId(observation.source, observation.source_transcript_part_id);
  assertIdentifier(observation.source_record_identity, 'invalid_record_identity');
  if (
    observation.source !== expected.source ||
    observation.source_session_id !== expected.sourceSessionId
  ) {
    throw new ArchiveContractError('scope_mismatch');
  }
  if (!Number.isSafeInteger(observation.observed_at)) {
    throw new ArchiveContractError('invalid_observed_at');
  }
  if (observation.payload_encoding !== 'utf8' && observation.payload_encoding !== 'base64') {
    throw new ArchiveContractError('invalid_payload_encoding');
  }
  if (typeof observation.payload !== 'string') {
    throw new ArchiveContractError('invalid_payload');
  }
  assertDigest(observation.content_sha256, 'invalid_content_hash');
  const normalized: ArchiveObservation = {
    archive_format_version: observation.archive_format_version,
    chain_hash_version: observation.chain_hash_version,
    source: observation.source,
    source_session_id: observation.source_session_id,
    source_transcript_part_id: observation.source_transcript_part_id,
    source_record_identity: observation.source_record_identity,
    observed_at: observation.observed_at as number,
    payload_encoding: observation.payload_encoding,
    payload: observation.payload,
    content_sha256: observation.content_sha256,
  };
  const bytes = payloadBytes(normalized);
  if (
    digestString(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) !==
    normalized.content_sha256
  ) {
    throw new ArchiveContractError('payload_hash_mismatch');
  }
  return normalized;
}

export function validateCheckpoint(
  value: unknown,
  expected: { source: ArchiveSource; sourceSessionId: string },
): CompletedScanCheckpoint {
  if (typeof value !== 'object' || value === null) {
    throw new ArchiveContractError('invalid_checkpoint');
  }
  const checkpoint = value as Record<string, unknown>;
  assertVersion(
    checkpoint.archive_format_version,
    ARCHIVE_FORMAT_VERSION,
    'unsupported_archive_format_version',
  );
  assertVersion(
    checkpoint.chain_hash_version,
    CHAIN_HASH_VERSION,
    'unsupported_chain_hash_version',
  );
  assertArchiveSource(checkpoint.source);
  assertIdentifier(checkpoint.source_session_id, 'invalid_source_session_id');
  assertIdentifier(checkpoint.source_transcript_part_id, 'invalid_transcript_part_id');
  assertTranscriptPartId(checkpoint.source, checkpoint.source_transcript_part_id);
  if (
    checkpoint.source !== expected.source ||
    checkpoint.source_session_id !== expected.sourceSessionId
  ) {
    throw new ArchiveContractError('scope_mismatch');
  }
  assertSafeInteger(checkpoint.record_count, 'invalid_checkpoint_count');
  if (
    checkpoint.last_source_record_identity !== null &&
    checkpoint.last_source_record_identity !== undefined
  ) {
    assertIdentifier(checkpoint.last_source_record_identity, 'invalid_checkpoint_identity');
  } else if (checkpoint.last_source_record_identity !== null) {
    throw new ArchiveContractError('invalid_checkpoint_identity');
  }
  assertSafeInteger(checkpoint.last_complete_byte_offset, 'invalid_checkpoint_offset');
  assertSafeInteger(checkpoint.observed_file_size, 'invalid_checkpoint_file_size');
  if (checkpoint.last_complete_byte_offset > checkpoint.observed_file_size) {
    throw new ArchiveContractError('invalid_checkpoint_offset');
  }
  assertDigest(checkpoint.complete_prefix_sha256, 'invalid_checkpoint_hash');
  assertDigest(checkpoint.prefix_chain_sha256, 'invalid_checkpoint_hash');
  if (!Number.isSafeInteger(checkpoint.first_observed_at)) {
    throw new ArchiveContractError('invalid_checkpoint_first_observed_at');
  }
  if ((checkpoint.record_count === 0) !== (checkpoint.last_source_record_identity === null)) {
    throw new ArchiveContractError('invalid_checkpoint_identity');
  }
  return {
    archive_format_version: checkpoint.archive_format_version,
    chain_hash_version: checkpoint.chain_hash_version,
    source: checkpoint.source,
    source_session_id: checkpoint.source_session_id,
    source_transcript_part_id: checkpoint.source_transcript_part_id,
    record_count: checkpoint.record_count,
    last_source_record_identity: checkpoint.last_source_record_identity,
    last_complete_byte_offset: checkpoint.last_complete_byte_offset,
    observed_file_size: checkpoint.observed_file_size,
    complete_prefix_sha256: checkpoint.complete_prefix_sha256,
    prefix_chain_sha256: checkpoint.prefix_chain_sha256,
    first_observed_at: checkpoint.first_observed_at as number,
  };
}

export function validateStoredRecordMetadata(
  value: unknown,
  expected: { source: ArchiveSource; sourceSessionId: string },
): asserts value is StoredRecordMetadata {
  if (typeof value !== 'object' || value === null) {
    throw new ArchiveContractError('invalid_stored_record');
  }
  const record = value as Record<string, unknown>;
  assertVersion(
    record.archive_format_version,
    ARCHIVE_FORMAT_VERSION,
    'unsupported_archive_format_version',
  );
  assertVersion(record.chain_hash_version, CHAIN_HASH_VERSION, 'unsupported_chain_hash_version');
  assertArchiveSource(record.source);
  assertIdentifier(record.source_session_id, 'invalid_source_session_id');
  assertIdentifier(record.source_transcript_part_id, 'invalid_transcript_part_id');
  assertTranscriptPartId(record.source, record.source_transcript_part_id);
  assertIdentifier(record.source_record_identity, 'invalid_record_identity');
  if (record.source !== expected.source || record.source_session_id !== expected.sourceSessionId) {
    throw new ArchiveContractError('stored_scope_mismatch');
  }
  if (!Number.isSafeInteger(record.observed_at)) {
    throw new ArchiveContractError('invalid_observed_at');
  }
  if (record.payload_encoding !== 'utf8' && record.payload_encoding !== 'base64') {
    throw new ArchiveContractError('invalid_payload_encoding');
  }
  assertDigest(record.content_sha256, 'invalid_content_hash');
  assertSafeInteger(record.chain_sequence, 'invalid_sequence');
  assertDigest(record.previous_chain_hash, 'invalid_previous_chain_hash');
  assertDigest(record.chain_hash, 'invalid_chain_hash');
}
