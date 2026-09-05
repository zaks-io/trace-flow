import { describe, expect, it } from 'vitest';
import { statusFor } from '../archive-ledger-support';

describe('archive ledger status mapping', () => {
  it.each([
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
  ])('maps genuine conflict %s to 409', (errorClass) => {
    expect(statusFor(errorClass)).toBe(409);
  });

  it.each(['unsupported_chain_hash_version', 'unsupported_archive_format_version'])(
    'keeps unsupported version %s as a client error',
    (errorClass) => {
      expect(statusFor(errorClass)).toBe(400);
    },
  );

  it.each(['historical_mistake', 'chain_failure', 'verification_failure', 'key_unavailable_extra'])(
    'does not classify arbitrary substring %s as a special response',
    (errorClass) => {
      expect(statusFor(errorClass)).toBe(400);
    },
  );
});
