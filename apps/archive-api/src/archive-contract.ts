export const ARCHIVE_FORMAT_VERSION = 1;
export const CHAIN_HASH_VERSION = 1;
export const MAX_CHUNK_BYTES = 1_572_864;
// This bounds one request's materialization. It is not a session lifetime cap.
export const MAX_UPLOAD_OBSERVATIONS = 16_384;
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const GENESIS_CHAIN_HASH = `sha256:${'00'.repeat(32)}`;

export type ArchiveSource = 'claude' | 'codex';
export type PayloadEncoding = 'utf8' | 'base64';

export interface ArchiveObservation {
  archive_format_version: number;
  chain_hash_version: number;
  source: ArchiveSource;
  source_session_id: string;
  source_transcript_part_id: string;
  source_record_identity: string;
  observed_at: number;
  payload_encoding: PayloadEncoding;
  payload: string;
  content_sha256: string;
}

export interface CompletedScanCheckpoint {
  archive_format_version: number;
  chain_hash_version: number;
  source: ArchiveSource;
  source_session_id: string;
  source_transcript_part_id: string;
  record_count: number;
  last_source_record_identity: string | null;
  last_complete_byte_offset: number;
  observed_file_size: number;
  complete_prefix_sha256: string;
  prefix_chain_sha256: string;
  first_observed_at: number;
}

export interface ArchiveAppendProof {
  prior_prefix_chain_sha256: string;
  appended_prefix_base64: string;
}

export interface ArchiveUploadRequest {
  source_session_id: string;
  observations: ArchiveObservation[];
  checkpoint: CompletedScanCheckpoint;
  prior_checkpoint?: CompletedScanCheckpoint;
  /** Optional exact bytes for the completed source prefix, including blank lines and separators. */
  complete_prefix_base64?: string;
  /** Bounded bytes appended after prior_checkpoint, never the cumulative source prefix. */
  append_proof?: ArchiveAppendProof;
}

export interface ArchiveScope {
  orgId: string;
  userId: string;
  contributionId: string;
  source: ArchiveSource;
  sourceSessionId: string;
}

export interface StoredRecord extends ArchiveObservation {
  kind: 'record';
  chain_sequence: number;
  previous_chain_hash: string;
  chain_hash: string;
}

export type StoredRecordMetadata = Omit<StoredRecord, 'payload'>;

export interface StoredCheckpoint {
  kind: 'checkpoint';
  archive_format_version: number;
  chain_hash_version: number;
  source: ArchiveSource;
  source_session_id: string;
  source_transcript_part_id: string;
  checkpoint: CompletedScanCheckpoint;
  chain_sequence: number;
  previous_chain_hash: string;
  chain_hash: string;
}

export type StoredElement = StoredRecord | StoredCheckpoint;
export type LedgerElement = StoredRecordMetadata | StoredCheckpoint;

export interface ChunkByteRange {
  chunk_id: string;
  start: number;
  end: number;
}

export interface ManifestRecord {
  element_type: 'record';
  chain_sequence: number;
  source_transcript_part_id: string;
  source_record_identity: string;
  content_sha256: string;
  chain_hash: string;
  byte_range: ChunkByteRange;
}

export interface ManifestCheckpoint {
  element_type: 'checkpoint';
  chain_sequence: number;
  checkpoint: CompletedScanCheckpoint;
  chain_hash: string;
  byte_range: ChunkByteRange;
}

export type ManifestElement = ManifestRecord | ManifestCheckpoint;

export interface ArchiveSessionManifest {
  archive_format_version: number;
  chain_hash_version: number;
  source: ArchiveSource;
  source_session_id: string;
  generation: number;
  element_count: number;
  chain_head: string;
  previous_page_key?: string;
  elements?: ManifestElement[];
  pages?: ManifestPageReference[];
}

export interface ManifestPageReference {
  page_key: string;
  element_start: number;
  element_count: number;
}

export interface ArchiveSessionManifestPage {
  archive_format_version: number;
  chain_hash_version: number;
  source: ArchiveSource;
  source_session_id: string;
  generation: number;
  element_start: number;
  element_count: number;
  previous_page_key?: string;
  elements?: ManifestElement[];
  pages?: ManifestPageReference[];
}

export class ArchiveContractError extends Error {
  constructor(
    readonly errorClass: string,
    message: string = errorClass,
  ) {
    super(message);
    this.name = 'ArchiveContractError';
  }
}

const IDENTIFIER_PATTERN = /^.+$/u;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function assertArchiveSource(value: unknown): asserts value is ArchiveSource {
  if (value !== 'claude' && value !== 'codex') {
    throw new ArchiveContractError('unsupported_source');
  }
}

export function assertIdentifier(value: unknown, errorClass: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !isWellFormedString(value) ||
    value.length === 0 ||
    value.length > 1024 ||
    !IDENTIFIER_PATTERN.test(value) ||
    hasControlCharacter(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..' ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new ArchiveContractError(errorClass);
  }
}

export function assertTranscriptPartId(source: ArchiveSource, value: string): void {
  const valid =
    source === 'codex'
      ? value === 'codex:part:primary'
      : value === 'claude:part:parent' || /^claude:part:sha256:[0-9a-f]{64}$/u.test(value);
  if (!valid) throw new ArchiveContractError('invalid_transcript_part_id');
}

export function assertDigest(value: unknown, errorClass: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new ArchiveContractError(errorClass);
  }
}

export function assertVersion(
  value: unknown,
  expected: number,
  errorClass: string,
): asserts value is number {
  if (value !== expected) {
    throw new ArchiveContractError(errorClass);
  }
}

export function assertSafeInteger(value: unknown, errorClass: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ArchiveContractError(errorClass);
  }
}

export function decodeBase64Bytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ArchiveContractError('invalid_payload_encoding');
  }
  const decoded = atob(value);
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const end = Math.min(offset + 0x8000, bytes.length);
    const chars = new Array<string>(end - offset);
    for (let index = offset; index < end; index++) {
      chars[index - offset] = String.fromCharCode(bytes[index]!);
    }
    binary += chars.join('');
  }
  const canonical = btoa(binary);
  if (canonical !== value) throw new ArchiveContractError('invalid_payload_encoding');
  return bytes;
}

export function payloadBytes(observation: ArchiveObservation): Uint8Array {
  if (observation.payload_encoding === 'utf8') {
    const bytes = new TextEncoder().encode(observation.payload);
    if (
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) !==
      observation.payload
    ) {
      throw new ArchiveContractError('invalid_payload_encoding');
    }
    return bytes;
  }
  if (observation.payload_encoding === 'base64') {
    const bytes = decodeBase64Bytes(observation.payload);
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return bytes;
    }
    throw new ArchiveContractError('noncanonical_payload_encoding');
  }
  throw new ArchiveContractError('invalid_payload_encoding');
}

export function digestBytes(value: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new ArchiveContractError('invalid_digest');
  }
  const hex = value.slice(7);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function digestString(bytes: Uint8Array): string {
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
