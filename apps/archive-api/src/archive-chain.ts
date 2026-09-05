import {
  ARCHIVE_FORMAT_VERSION,
  ArchiveContractError,
  CHAIN_HASH_VERSION,
  type ArchiveObservation,
  type CompletedScanCheckpoint,
  type LedgerElement,
  type StoredElement,
  type StoredRecord,
  digestBytes,
  digestString,
} from './archive-contract';

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

function checkpointLogicalKey(checkpoint: CompletedScanCheckpoint): string {
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

export async function assertPlannedChain(
  previousChainHash: string,
  firstSequence: number,
  elements: LedgerElement[],
): Promise<void> {
  let previous = previousChainHash;
  for (const [offset, element] of elements.entries()) {
    const sequence = firstSequence + offset;
    if (element.chain_sequence !== sequence || element.previous_chain_hash !== previous) {
      throw new ArchiveContractError('chain_link_verification_failed');
    }
    const expected =
      element.kind === 'record'
        ? await recordChainHash(previous, sequence, element)
        : await checkpointChainHash(previous, sequence, element.checkpoint);
    if (element.chain_hash !== expected) {
      throw new ArchiveContractError('chain_link_verification_failed');
    }
    previous = element.chain_hash;
  }
}
