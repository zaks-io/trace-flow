export const ARCHIVE_INTEGRITY_ERROR_CLASSES = [
  'checkpoint_describes_wrong_scan',
  'checkpoint_part_mismatch',
  'checkpoint_prefix_unverifiable',
  'checkpoint_regressed',
  'chain_link_verification_failed',
  'compressed_chunk_verification_failed',
  'duplicate_record_version',
  'historical_prefix_changed',
  'immutable_object_collision',
  'invalid_checkpoint',
  'invalid_checkpoint_first_observed_at',
  'invalid_checkpoint_identity',
  'invalid_checkpoint_offset',
  'invalid_checkpoint_prefix',
  'manifest_encryption_verification_failed',
  'missing_historical_prefix_proof',
  'payload_hash_mismatch',
  'pending_intent_corrupt',
  'pending_intent_head_mismatch',
  'pending_intent_mismatch',
  'pending_object_verification_failed',
  'r2_object_verification_failed',
  'scope_mismatch',
  'unexpected_historical_prefix_proof',
] as const;

export type ArchiveIntegrityErrorClass = (typeof ARCHIVE_INTEGRITY_ERROR_CLASSES)[number];

const ARCHIVE_INTEGRITY_ERROR_CLASS_SET = new Set<string>(ARCHIVE_INTEGRITY_ERROR_CLASSES);

export function isArchiveIntegrityErrorClass(value: unknown): value is ArchiveIntegrityErrorClass {
  return typeof value === 'string' && ARCHIVE_INTEGRITY_ERROR_CLASS_SET.has(value);
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

export function isArchiveCanonicalIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (!isWellFormedString(value) || value === '.' || value === '..') return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || value[index] === '/' || value[index] === '\\') {
      return false;
    }
  }
  return true;
}
