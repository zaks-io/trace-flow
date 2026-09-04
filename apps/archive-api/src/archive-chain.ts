import {
  ARCHIVE_FORMAT_VERSION,
  ArchiveContractError,
  CHAIN_HASH_VERSION,
  GENESIS_CHAIN_HASH,
  type ArchiveObservation,
  type ArchiveSource,
  type CompletedScanCheckpoint,
  type LedgerElement,
  type StoredCheckpoint,
  type StoredElement,
  type StoredRecord,
  type StoredRecordMetadata,
  digestBytes,
  digestString,
} from './archive-contract';
import { validateCheckpoint, validateStoredRecordMetadata } from './archive-contract-validation';

const RECORD_DOMAIN = new TextEncoder().encode('trace-flow/archive/record-chain/v1');
const CHECKPOINT_DOMAIN = new TextEncoder().encode('trace-flow/archive/checkpoint-chain/v1');

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function numberBytes(value: number, signed = false): Uint8Array {
  if (!Number.isSafeInteger(value)) throw new ArchiveContractError('invalid_integer');
  const bytes = new Uint8Array(8);
  let remaining = BigInt(value);
  if (signed && remaining < 0) remaining += 1n << 64n;
  if (remaining < 0n || remaining >= 1n << 64n) {
    throw new ArchiveContractError('invalid_integer');
  }
  for (let index = 7; index >= 0; index--) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function versionBytes(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new ArchiveContractError('invalid_version');
  }
  return new Uint8Array([value >>> 8, value & 0xff]);
}

export async function hashFramed(domain: Uint8Array, fields: Uint8Array[]): Promise<string> {
  const total = [domain, ...fields].reduce((sum, field) => sum + 8 + field.length, 0);
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  let offset = 0;
  for (const field of [domain, ...fields]) {
    view.setBigUint64(offset, BigInt(field.length), false);
    offset += 8;
    frame.set(field, offset);
    offset += field.length;
  }
  return digestString(new Uint8Array(await crypto.subtle.digest('SHA-256', frame)));
}

export async function recordChainHash(
  previous: string,
  sequence: number,
  observation: Pick<
    ArchiveObservation,
    | 'archive_format_version'
    | 'chain_hash_version'
    | 'source'
    | 'source_session_id'
    | 'source_transcript_part_id'
    | 'source_record_identity'
    | 'observed_at'
    | 'payload_encoding'
    | 'content_sha256'
  >,
): Promise<string> {
  return hashFramed(RECORD_DOMAIN, [
    digestBytes(previous),
    versionBytes(observation.archive_format_version),
    versionBytes(observation.chain_hash_version),
    utf8(observation.source),
    utf8(observation.source_session_id),
    utf8(observation.source_transcript_part_id),
    utf8(observation.source_record_identity),
    numberBytes(observation.observed_at, true),
    utf8(observation.payload_encoding),
    digestBytes(observation.content_sha256),
    numberBytes(sequence),
  ]);
}

export async function checkpointChainHash(
  previous: string,
  sequence: number,
  checkpoint: CompletedScanCheckpoint,
): Promise<string> {
  return hashFramed(CHECKPOINT_DOMAIN, [
    digestBytes(previous),
    versionBytes(ARCHIVE_FORMAT_VERSION),
    versionBytes(CHAIN_HASH_VERSION),
    utf8(checkpoint.source),
    utf8(checkpoint.source_session_id),
    utf8(checkpoint.source_transcript_part_id),
    versionBytes(checkpoint.archive_format_version),
    versionBytes(checkpoint.chain_hash_version),
    utf8(checkpoint.source),
    utf8(checkpoint.source_session_id),
    utf8(checkpoint.source_transcript_part_id),
    numberBytes(checkpoint.record_count),
    utf8(checkpoint.last_source_record_identity ?? ''),
    numberBytes(checkpoint.last_complete_byte_offset),
    numberBytes(checkpoint.observed_file_size),
    digestBytes(checkpoint.complete_prefix_sha256),
    digestBytes(checkpoint.prefix_chain_sha256),
    numberBytes(checkpoint.first_observed_at, true),
    numberBytes(sequence),
  ]);
}

export function canonicalElement(element: StoredElement): string {
  return JSON.stringify(element);
}

export function canonicalElements(elements: StoredElement[]): Uint8Array {
  const lines = elements.map((element) => `${canonicalElement(element)}\n`).join('');
  return new TextEncoder().encode(lines);
}

export function observationFingerprint(
  observation: Pick<
    ArchiveObservation,
    'source_transcript_part_id' | 'source_record_identity' | 'content_sha256'
  >,
): string {
  return JSON.stringify({
    source_transcript_part_id: observation.source_transcript_part_id,
    source_record_identity: observation.source_record_identity,
    content_sha256: observation.content_sha256,
  });
}

export function checkpointLogicalKey(checkpoint: CompletedScanCheckpoint): string {
  return JSON.stringify({
    archive_format_version: checkpoint.archive_format_version,
    chain_hash_version: checkpoint.chain_hash_version,
    source: checkpoint.source,
    source_session_id: checkpoint.source_session_id,
    source_transcript_part_id: checkpoint.source_transcript_part_id,
    record_count: checkpoint.record_count,
    last_source_record_identity: checkpoint.last_source_record_identity,
    last_complete_byte_offset: checkpoint.last_complete_byte_offset,
    complete_prefix_sha256: checkpoint.complete_prefix_sha256,
    prefix_chain_sha256: checkpoint.prefix_chain_sha256,
  });
}

export function sameCheckpointLogicalPosition(
  left: CompletedScanCheckpoint,
  right: CompletedScanCheckpoint,
): boolean {
  return checkpointLogicalKey(left) === checkpointLogicalKey(right);
}

export function storedRecordToObservation(record: StoredRecord): ArchiveObservation {
  return {
    archive_format_version: record.archive_format_version,
    chain_hash_version: record.chain_hash_version,
    source: record.source,
    source_session_id: record.source_session_id,
    source_transcript_part_id: record.source_transcript_part_id,
    source_record_identity: record.source_record_identity,
    observed_at: record.observed_at,
    payload_encoding: record.payload_encoding,
    payload: record.payload,
    content_sha256: record.content_sha256,
  };
}

export function checkpointWrapper(
  checkpoint: CompletedScanCheckpoint,
  sequence: number,
  previous_chain_hash: string,
  chain_hash: string,
): StoredCheckpoint {
  return {
    kind: 'checkpoint',
    archive_format_version: ARCHIVE_FORMAT_VERSION,
    chain_hash_version: CHAIN_HASH_VERSION,
    source: checkpoint.source,
    source_session_id: checkpoint.source_session_id,
    source_transcript_part_id: checkpoint.source_transcript_part_id,
    checkpoint,
    chain_sequence: sequence,
    previous_chain_hash,
    chain_hash,
  };
}

export async function buildRecord(
  observation: ArchiveObservation,
  sequence: number,
  previous_chain_hash: string,
): Promise<StoredRecord> {
  const chain_hash = await recordChainHash(previous_chain_hash, sequence, observation);
  return {
    kind: 'record',
    ...observation,
    chain_sequence: sequence,
    previous_chain_hash,
    chain_hash,
  };
}

export function assertStoredElementScope(
  element: LedgerElement,
  expected: { source: ArchiveSource; sourceSessionId: string },
): void {
  if (
    element.source !== expected.source ||
    element.source_session_id !== expected.sourceSessionId
  ) {
    throw new ArchiveContractError('stored_scope_mismatch');
  }
  if (element.kind === 'record') {
    validateStoredRecordMetadata(element, expected);
    return;
  }
  if (
    element.archive_format_version !== ARCHIVE_FORMAT_VERSION ||
    element.chain_hash_version !== CHAIN_HASH_VERSION ||
    element.source_transcript_part_id !== element.checkpoint.source_transcript_part_id
  ) {
    throw new ArchiveContractError('stored_checkpoint_mismatch');
  }
  if (!Number.isSafeInteger(element.chain_sequence) || element.chain_sequence < 0) {
    throw new ArchiveContractError('invalid_sequence');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(element.previous_chain_hash)) {
    throw new ArchiveContractError('invalid_previous_chain_hash');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(element.chain_hash)) {
    throw new ArchiveContractError('invalid_chain_hash');
  }
  validateCheckpoint(element.checkpoint, expected);
}

export function latestCheckpoint(
  elements: StoredElement[],
  partId: string,
): CompletedScanCheckpoint | undefined {
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index];
    if (!element) continue;
    if (element.kind === 'checkpoint' && element.source_transcript_part_id === partId) {
      return element.checkpoint;
    }
  }
  return undefined;
}

export function storedRecordFingerprints(elements: LedgerElement[], partId: string): string[] {
  return elements
    .filter(
      (element): element is StoredRecordMetadata =>
        element.kind === 'record' && element.source_transcript_part_id === partId,
    )
    .map((record) =>
      JSON.stringify({
        source_transcript_part_id: record.source_transcript_part_id,
        source_record_identity: record.source_record_identity,
        content_sha256: record.content_sha256,
      }),
    );
}

export function genesisChainHead(): string {
  return GENESIS_CHAIN_HASH;
}
