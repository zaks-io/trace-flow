import {
  ARCHIVE_UPLOAD_WIRE_VERSION,
  ArchiveContractError,
  MAX_UPLOAD_OBSERVATIONS,
  type ArchiveObservation,
  type ArchiveScope,
  type CompletedScanCheckpoint,
  decodeBase64Bytes,
} from './archive-contract';
import { validateCheckpoint, validateObservation } from './archive-contract-validation';
import {
  assertDeltaPrefixHash,
  assertPrefixHash,
  prefixRecordLines,
  type ValidatedArchiveAppendProof,
} from './archive-prefix-validation';

export interface ValidatedArchiveUpload {
  sourceSessionId: string;
  observations: ArchiveObservation[];
  checkpoint: CompletedScanCheckpoint;
  priorCheckpoint?: CompletedScanCheckpoint;
  completePrefix?: Uint8Array;
  appendProof?: ValidatedArchiveAppendProof;
  proofLines?: Uint8Array[];
  isDelta: boolean;
}

export function archiveUploadIntentIdentity(upload: ValidatedArchiveUpload): unknown {
  return {
    sourceSessionId: upload.sourceSessionId,
    observations: upload.observations.map(({ payload: _payload, ...metadata }) => metadata),
    checkpoint: upload.checkpoint,
    priorCheckpoint: upload.priorCheckpoint,
    appendProof: upload.appendProof
      ? { priorPrefixChainSha256: upload.appendProof.priorPrefixChainSha256 }
      : undefined,
    isDelta: upload.isDelta,
  };
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
  const wireVersion = value.archive_upload_wire_version;
  const compact = wireVersion === ARCHIVE_UPLOAD_WIRE_VERSION;
  if (wireVersion !== undefined && !compact) {
    throw new ArchiveContractError('unsupported_archive_upload_wire_version');
  }
  const completePrefixBase64 = value.complete_prefix_base64;
  const completePrefixUtf8 = value.complete_prefix_utf8;
  if (completePrefixBase64 !== undefined && typeof completePrefixBase64 !== 'string') {
    throw new ArchiveContractError('invalid_checkpoint_prefix');
  }
  if (completePrefixUtf8 !== undefined && typeof completePrefixUtf8 !== 'string') {
    throw new ArchiveContractError('invalid_checkpoint_prefix');
  }
  if (
    (compact && completePrefixBase64 !== undefined) ||
    (!compact && completePrefixUtf8 !== undefined) ||
    (completePrefixBase64 !== undefined && completePrefixUtf8 !== undefined)
  ) {
    throw new ArchiveContractError('invalid_checkpoint_prefix');
  }
  const proof = value.append_proof;
  let appendProof: ValidatedArchiveAppendProof | undefined;
  if (proof !== undefined) {
    if (!isRecord(proof) || typeof proof.prior_prefix_chain_sha256 !== 'string') {
      throw new ArchiveContractError('invalid_checkpoint_prefix');
    }
    const base64Proof = proof.appended_prefix_base64;
    const utf8Proof = proof.appended_prefix_utf8;
    if (
      (compact && (typeof utf8Proof !== 'string' || base64Proof !== undefined)) ||
      (!compact && (typeof base64Proof !== 'string' || utf8Proof !== undefined))
    ) {
      throw new ArchiveContractError('invalid_checkpoint_prefix');
    }
    appendProof = {
      priorPrefixChainSha256: proof.prior_prefix_chain_sha256,
      appendedPrefix: compact
        ? new TextEncoder().encode(utf8Proof as string)
        : decodeBase64Bytes(base64Proof as string),
    };
  }
  const completePrefix =
    completePrefixUtf8 !== undefined
      ? new TextEncoder().encode(completePrefixUtf8)
      : completePrefixBase64 !== undefined
        ? decodeBase64Bytes(completePrefixBase64)
        : undefined;
  const proofBytes = completePrefix ?? appendProof?.appendedPrefix;
  const proofLines = proofBytes === undefined ? undefined : prefixRecordLines(proofBytes);
  const compactPayloads = compact ? (proofLines ?? []) : undefined;
  if (compactPayloads && compactPayloads.length !== value.observations.length) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  const observations = await Promise.all(
    value.observations.map((observation, index) =>
      validateObservation(
        observation,
        {
          source: scope.source,
          sourceSessionId: scope.sourceSessionId,
        },
        compactPayloads?.[index],
      ),
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
  if (completePrefix !== undefined && appendProof !== undefined) {
    throw new ArchiveContractError('invalid_checkpoint_prefix');
  }
  if (
    observations.some(
      (observation) =>
        observation.source_transcript_part_id !== checkpoint.source_transcript_part_id,
    )
  ) {
    throw new ArchiveContractError('checkpoint_part_mismatch');
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
    await assertDeltaPrefixHash(
      observations,
      checkpoint,
      priorCheckpoint,
      appendProof,
      compact ? proofLines : undefined,
    );
  } else {
    await assertPrefixHash(
      observations,
      checkpoint,
      completePrefix,
      priorCheckpoint,
      compact ? proofLines : undefined,
    );
  }
  return {
    sourceSessionId: scope.sourceSessionId,
    observations,
    checkpoint,
    priorCheckpoint,
    completePrefix,
    appendProof,
    proofLines: compact ? proofLines : undefined,
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
