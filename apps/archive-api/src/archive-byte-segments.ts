import {
  ArchiveContractError,
  type ArchiveObservation,
  payloadBytes,
  assertTranscriptPartId,
} from './archive-contract';

export const BYTE_ARCHIVE_FORMAT_VERSION = 2;
const MAX_BYTE_SEGMENT_BYTES = 512 * 1024;

export function byteSegmentRange(identity: string): {
  start: number;
  end: number;
  predecessorPartId?: string;
} {
  const match = /^bytes:(0|[1-9][0-9]*):(0|[1-9][0-9]*)(?::from:(.+))?$/u.exec(identity);
  if (!match) throw new ArchiveContractError('invalid_byte_segment_identity');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    end - start > MAX_BYTE_SEGMENT_BYTES
  ) {
    throw new ArchiveContractError('invalid_byte_segment_range');
  }
  const predecessorPartId = match[3];
  if (predecessorPartId !== undefined) {
    const source = predecessorPartId.startsWith('codex:') ? 'codex' : 'claude';
    assertTranscriptPartId(source, predecessorPartId);
  }
  return { start, end, ...(predecessorPartId ? { predecessorPartId } : {}) };
}

export function assertByteSegments(
  observations: ArchiveObservation[],
  prefix: Uint8Array,
  start: number,
): void {
  let offset = start;
  let predecessorPartId: string | undefined;
  let predecessorInitialized = false;
  for (const observation of observations) {
    if (observation.archive_format_version !== BYTE_ARCHIVE_FORMAT_VERSION) {
      throw new ArchiveContractError('mixed_archive_formats');
    }
    const range = byteSegmentRange(observation.source_record_identity);
    if (range.predecessorPartId) {
      assertTranscriptPartId(observation.source, range.predecessorPartId);
      if (range.predecessorPartId === observation.source_transcript_part_id)
        throw new ArchiveContractError('invalid_generation_predecessor');
    }
    if (!predecessorInitialized) {
      predecessorPartId = range.predecessorPartId;
      predecessorInitialized = true;
    } else if (range.predecessorPartId !== predecessorPartId) {
      throw new ArchiveContractError('generation_predecessor_changed');
    }
    const bytes = payloadBytes(observation);
    if (range.start !== offset || range.end - range.start !== bytes.length) {
      throw new ArchiveContractError('byte_segment_gap');
    }
    const expected = prefix.subarray(offset - start, range.end - start);
    if (expected.length !== bytes.length || bytes.some((byte, index) => byte !== expected[index])) {
      throw new ArchiveContractError('checkpoint_prefix_unverifiable');
    }
    offset = range.end;
  }
  if (offset - start !== prefix.length) throw new ArchiveContractError('byte_segment_gap');
}
