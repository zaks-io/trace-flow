import { ArchiveContractError, type LedgerElement } from './archive-contract';
import type { SourceFingerprint } from './archive-validation';

export const LEDGER_PAGE_SIZE = 256;

function versionKey(fingerprint: SourceFingerprint): string {
  return JSON.stringify([
    fingerprint.source_transcript_part_id,
    fingerprint.source_record_identity,
    fingerprint.content_sha256,
  ]);
}

export function hasRecordVersion(
  storage: DurableObjectStorage,
  fingerprint: SourceFingerprint,
): boolean {
  const row = [
    ...storage.sql.exec<{ version_key: string }>(
      'SELECT version_key FROM ledger_record_versions WHERE version_key = ?',
      versionKey(fingerprint),
    ),
  ][0];
  return row?.version_key === versionKey(fingerprint);
}

export function sameFingerprintPrefix(
  storage: DurableObjectStorage,
  partId: string,
  incoming: SourceFingerprint[],
  requiredLength = incoming.length,
): boolean {
  if (incoming.length < requiredLength) return false;
  return sameFingerprintRange(storage, partId, incoming.slice(0, requiredLength), 0);
}

export function sameFingerprintRange(
  storage: DurableObjectStorage,
  partId: string,
  incoming: SourceFingerprint[],
  startIndex: number,
): boolean {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) return false;
  for (let offset = 0; offset < incoming.length; offset += LEDGER_PAGE_SIZE) {
    const expected = incoming.slice(offset, offset + LEDGER_PAGE_SIZE);
    const rows = [
      ...storage.sql.exec<{ data: string }>(
        'SELECT data FROM ledger_scan_fingerprints WHERE part_id = ? AND fingerprint_index >= ? ORDER BY fingerprint_index LIMIT ?',
        partId,
        startIndex + offset,
        expected.length,
      ),
    ];
    if (rows.length !== expected.length) return false;
    for (const [index, row] of rows.entries()) {
      try {
        if (JSON.stringify(JSON.parse(row.data)) !== JSON.stringify(expected[index])) return false;
      } catch {
        throw new ArchiveContractError('ledger_state_corrupt');
      }
    }
  }
  return true;
}

export function readInitialLedgerElementPageWithRanges(
  storage: DurableObjectStorage,
): { element: LedgerElement; range: { chunk_id: string; start: number; end: number } }[] {
  return [
    ...storage.sql.exec<{
      element_data: string;
      range_data: string;
    }>(
      'SELECT e.data AS element_data, r.data AS range_data FROM ledger_elements e JOIN ledger_ranges r ON r.sequence = e.sequence ORDER BY e.sequence LIMIT ?',
      LEDGER_PAGE_SIZE,
    ),
  ].map((row) => {
    try {
      return {
        element: JSON.parse(row.element_data) as LedgerElement,
        range: JSON.parse(row.range_data) as { chunk_id: string; start: number; end: number },
      };
    } catch {
      throw new ArchiveContractError('ledger_state_corrupt');
    }
  });
}
