import {
  ArchiveContractError,
  MAX_UPLOAD_OBSERVATIONS,
  type ArchiveObservation,
  type ArchiveScope,
  type ArchiveUploadRequest,
  type CompletedScanCheckpoint,
} from './archive-contract';
import { validateCheckpoint, validateObservation } from './archive-contract-validation';
import { assertDeltaPrefixHash, assertPrefixHash } from './archive-prefix-validation';

export interface ValidatedArchiveUpload {
  sourceSessionId: string;
  observations: ArchiveObservation[];
  checkpoint: CompletedScanCheckpoint;
  priorCheckpoint?: CompletedScanCheckpoint;
  completePrefixBase64?: string;
  appendProof?: ArchiveUploadRequest['append_proof'];
  isDelta: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertIncomingObservationCount(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.observations)) return;
  if (value.observations.length > MAX_UPLOAD_OBSERVATIONS) {
    throw new ArchiveContractError('archive_upload_observation_limit');
  }
}

export async function parseAndValidateUpload(
  value: unknown,
  scope: ArchiveScope,
): Promise<ValidatedArchiveUpload> {
  if (!isRecord(value)) throw new ArchiveContractError('invalid_upload');
  assertIncomingObservationCount(value);
  if (value.source_session_id !== scope.sourceSessionId) {
    throw new ArchiveContractError('scope_mismatch');
  }
  if (!Array.isArray(value.observations)) {
    throw new ArchiveContractError('invalid_observations');
  }
  const observations = await Promise.all(
    value.observations.map((observation) =>
      validateObservation(observation, {
        source: scope.source,
        sourceSessionId: scope.sourceSessionId,
      }),
    ),
  );
  const checkpoint = validateCheckpoint(value.checkpoint, {
    source: scope.source,
    sourceSessionId: scope.sourceSessionId,
  });
  const priorCheckpoint =
    value.prior_checkpoint === undefined
      ? undefined
      : validateCheckpoint(value.prior_checkpoint, {
          source: scope.source,
          sourceSessionId: scope.sourceSessionId,
        });
  if (
    observations.some(
      (observation) =>
        observation.source_transcript_part_id !== checkpoint.source_transcript_part_id,
    )
  ) {
    throw new ArchiveContractError('checkpoint_part_mismatch');
  }
  const completePrefixBase64 = value.complete_prefix_base64;
  if (completePrefixBase64 !== undefined && typeof completePrefixBase64 !== 'string') {
    throw new ArchiveContractError('invalid_checkpoint_prefix');
  }
  const appendProof = value.append_proof as ArchiveUploadRequest['append_proof'];
  if (appendProof !== undefined) {
    if (typeof appendProof !== 'object' || appendProof === null || Array.isArray(appendProof)) {
      throw new ArchiveContractError('invalid_checkpoint_prefix');
    }
    const proof = appendProof as unknown as Record<string, unknown>;
    if (
      typeof proof.prior_prefix_chain_sha256 !== 'string' ||
      typeof proof.appended_prefix_base64 !== 'string'
    ) {
      throw new ArchiveContractError('invalid_checkpoint_prefix');
    }
  }
  const lastObservationIdentity = observations.at(-1)?.source_record_identity ?? null;
  const isFullScan =
    checkpoint.record_count === observations.length &&
    checkpoint.last_source_record_identity === lastObservationIdentity;
  const isDelta =
    priorCheckpoint !== undefined &&
    checkpoint.record_count >= priorCheckpoint.record_count &&
    checkpoint.record_count - priorCheckpoint.record_count === observations.length &&
    checkpoint.last_source_record_identity ===
      (lastObservationIdentity ?? priorCheckpoint.last_source_record_identity);
  if (!isFullScan && !isDelta) {
    throw new ArchiveContractError('checkpoint_describes_wrong_scan');
  }
  if (priorCheckpoint) {
    if (
      checkpoint.source_transcript_part_id !== priorCheckpoint.source_transcript_part_id ||
      checkpoint.first_observed_at !== priorCheckpoint.first_observed_at ||
      checkpoint.last_complete_byte_offset < priorCheckpoint.last_complete_byte_offset ||
      checkpoint.observed_file_size < priorCheckpoint.observed_file_size
    ) {
      throw new ArchiveContractError('checkpoint_regressed');
    }
  }
  if (isDelta) {
    await assertDeltaPrefixHash(observations, checkpoint, priorCheckpoint, appendProof);
  } else {
    await assertPrefixHash(observations, checkpoint, completePrefixBase64, priorCheckpoint);
  }
  return {
    sourceSessionId: scope.sourceSessionId,
    observations,
    checkpoint,
    priorCheckpoint,
    completePrefixBase64,
    appendProof,
    isDelta,
  };
}

export interface SourceFingerprint {
  source_transcript_part_id: string;
  source_record_identity: string;
  content_sha256: string;
}

export function sourceFingerprints(observations: ArchiveObservation[]): SourceFingerprint[] {
  return observations.map(
    ({ source_transcript_part_id, source_record_identity, content_sha256 }) => ({
      source_transcript_part_id,
      source_record_identity,
      content_sha256,
    }),
  );
}

export function sameFingerprintPrefix(
  incoming: SourceFingerprint[],
  stored: SourceFingerprint[],
): boolean {
  if (incoming.length < stored.length) return false;
  return stored.every((expected, index) => {
    const actual = incoming[index];
    return (
      actual?.source_transcript_part_id === expected.source_transcript_part_id &&
      actual.source_record_identity === expected.source_record_identity &&
      actual.content_sha256 === expected.content_sha256
    );
  });
}
