import {
  ARCHIVE_FORMAT_VERSION,
  ArchiveContractError,
  CHAIN_HASH_VERSION,
  GENESIS_CHAIN_HASH,
  type StoredElement,
} from './archive-contract';
import {
  buildRecord,
  checkpointChainHash,
  observationFingerprint,
  sameCheckpointLogicalPosition,
} from './archive-chain';
import {
  hasRecordVersion,
  sameFingerprintPrefix,
  sameFingerprintRange,
} from './archive-ledger-index';
import {
  assertDeltaPrefixHash,
  assertPrefixHash,
  assertStoredPrefixHash,
} from './archive-prefix-validation';
import { sourceFingerprints, type ValidatedArchiveUpload } from './archive-validation';
import type { LedgerSnapshot, ScanState } from './archive-ledger-state';

export interface ReconciledUpload {
  newElements: StoredElement[];
  appendCheckpoint: boolean;
}

function allVersionsExist(
  storage: DurableObjectStorage,
  fingerprints: ReturnType<typeof sourceFingerprints>,
): boolean {
  return fingerprints.every((fingerprint) => hasRecordVersion(storage, fingerprint));
}

async function assertFullScanHistory(
  storage: DurableObjectStorage,
  upload: ValidatedArchiveUpload,
  previous: ScanState,
): Promise<void> {
  const fingerprints = sourceFingerprints(upload.observations);
  if (upload.observations.length < previous.checkpoint.record_count) {
    throw new ArchiveContractError('missing_historical_prefix_proof');
  }
  if (
    !sameFingerprintPrefix(
      storage,
      upload.checkpoint.source_transcript_part_id,
      fingerprints,
      previous.checkpoint.record_count,
    )
  ) {
    throw new ArchiveContractError('historical_prefix_changed');
  }
  if (!upload.priorCheckpoint) {
    await assertStoredPrefixHash(upload.completePrefixBase64, previous.checkpoint);
  }
  await assertPrefixHash(
    upload.observations,
    upload.checkpoint,
    upload.completePrefixBase64,
    upload.priorCheckpoint,
  );
}

export async function reconcileArchiveUpload(
  storage: DurableObjectStorage,
  state: LedgerSnapshot,
  upload: ValidatedArchiveUpload,
  scan: ScanState | undefined,
): Promise<ReconciledUpload> {
  const incomingVersions = new Set<string>();
  for (const observation of upload.observations) {
    const fingerprint = observationFingerprint(observation);
    if (incomingVersions.has(fingerprint)) {
      throw new ArchiveContractError('duplicate_record_version');
    }
    incomingVersions.add(fingerprint);
  }

  if (scan && upload.checkpoint.observed_file_size < scan.checkpoint.observed_file_size) {
    throw new ArchiveContractError('checkpoint_regressed');
  }
  const duplicateScan = scan && sameCheckpointLogicalPosition(scan.checkpoint, upload.checkpoint);
  if (scan) {
    if (upload.isDelta) {
      const fingerprints = sourceFingerprints(upload.observations);
      if (
        duplicateScan &&
        upload.priorCheckpoint &&
        upload.priorCheckpoint.record_count + fingerprints.length ===
          upload.checkpoint.record_count &&
        sameFingerprintRange(
          storage,
          upload.checkpoint.source_transcript_part_id,
          fingerprints,
          upload.priorCheckpoint.record_count,
        ) &&
        allVersionsExist(storage, fingerprints)
      ) {
        return { newElements: [], appendCheckpoint: false };
      }
      if (
        !upload.priorCheckpoint ||
        !sameCheckpointLogicalPosition(scan.checkpoint, upload.priorCheckpoint)
      ) {
        throw new ArchiveContractError('missing_historical_prefix_proof');
      }
      await assertDeltaPrefixHash(
        upload.observations,
        upload.checkpoint,
        upload.priorCheckpoint,
        upload.appendProof,
      );
    } else {
      if (
        upload.priorCheckpoint &&
        !sameCheckpointLogicalPosition(scan.checkpoint, upload.priorCheckpoint)
      ) {
        throw new ArchiveContractError('missing_historical_prefix_proof');
      }
      if (duplicateScan) {
        await assertFullScanHistory(storage, upload, scan);
        if (
          !sameFingerprintPrefix(
            storage,
            upload.checkpoint.source_transcript_part_id,
            sourceFingerprints(upload.observations),
            scan.checkpoint.record_count,
          ) ||
          !allVersionsExist(storage, sourceFingerprints(upload.observations))
        ) {
          throw new ArchiveContractError('historical_prefix_changed');
        }
        return { newElements: [], appendCheckpoint: false };
      }
      await assertFullScanHistory(storage, upload, scan);
    }
  } else if (upload.priorCheckpoint) {
    throw new ArchiveContractError('unexpected_historical_prefix_proof');
  }

  const newElements: StoredElement[] = [];
  const knownVersions = new Set<string>();
  let chainHead = state.chainHead || GENESIS_CHAIN_HASH;
  for (const observation of upload.observations) {
    const fingerprint = observationFingerprint(observation);
    if (
      hasRecordVersion(storage, {
        source_transcript_part_id: observation.source_transcript_part_id,
        source_record_identity: observation.source_record_identity,
        content_sha256: observation.content_sha256,
      })
    ) {
      knownVersions.add(fingerprint);
      continue;
    }
    if (knownVersions.has(fingerprint)) {
      throw new ArchiveContractError('duplicate_record_version');
    }
    const record = await buildRecord(
      observation,
      state.elementCount + newElements.length,
      chainHead,
    );
    newElements.push(record);
    knownVersions.add(fingerprint);
    chainHead = record.chain_hash;
  }

  const appendCheckpoint = !scan || !duplicateScan;
  if (appendCheckpoint) {
    const sequence = state.elementCount + newElements.length;
    newElements.push({
      kind: 'checkpoint' as const,
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      chain_hash_version: CHAIN_HASH_VERSION,
      source: upload.checkpoint.source,
      source_session_id: upload.checkpoint.source_session_id,
      source_transcript_part_id: upload.checkpoint.source_transcript_part_id,
      checkpoint: upload.checkpoint,
      chain_sequence: sequence,
      previous_chain_hash: chainHead,
      chain_hash: await checkpointChainHash(chainHead, sequence, upload.checkpoint),
    });
  }
  return { newElements, appendCheckpoint };
}
