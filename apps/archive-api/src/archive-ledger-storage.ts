import {
  ArchiveContractError,
  GENESIS_CHAIN_HASH,
  type ChunkByteRange,
  type LedgerElement,
} from './archive-contract';
import type { SourceFingerprint } from './archive-validation';
import type { LedgerCommit, LedgerSnapshot, ScanState } from './archive-ledger-state';

function ensureLedgerTables(storage: DurableObjectStorage): void {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS ledger_record_versions (version_key TEXT PRIMARY KEY, part_id TEXT NOT NULL, record_identity TEXT NOT NULL, content_hash TEXT NOT NULL, sequence INTEGER NOT NULL)',
  );
  storage.sql.exec(
    'CREATE INDEX IF NOT EXISTS ledger_record_versions_identity ON ledger_record_versions (part_id, record_identity)',
  );
}

function recordVersionKey(
  partId: string,
  sourceRecordIdentity: string,
  contentSha256: string,
): string {
  return JSON.stringify([partId, sourceRecordIdentity, contentSha256]);
}

function stateMetadata(state: LedgerCommit): string {
  return JSON.stringify({
    scope: state.scope,
    keyVersion: state.keyVersion,
    elementCount: state.elementCount,
    recordCount: state.recordCount,
    chainHead: state.chainHead,
    generation: state.generation,
    manifestKey: state.manifestKey,
    manifestHeadPageKey: state.manifestHeadPageKey,
  });
}

function insertElement(storage: DurableObjectStorage, element: LedgerElement): void {
  storage.sql.exec(
    'INSERT INTO ledger_elements (sequence, data) VALUES (?, ?)',
    element.chain_sequence,
    JSON.stringify(element),
  );
  if (element.kind === 'record') {
    storage.sql.exec(
      'INSERT INTO ledger_record_versions (version_key, part_id, record_identity, content_hash, sequence) VALUES (?, ?, ?, ?, ?)',
      recordVersionKey(
        element.source_transcript_part_id,
        element.source_record_identity,
        element.content_sha256,
      ),
      element.source_transcript_part_id,
      element.source_record_identity,
      element.content_sha256,
      element.chain_sequence,
    );
  }
}

function insertRange(storage: DurableObjectStorage, sequence: number, range: ChunkByteRange): void {
  storage.sql.exec(
    'INSERT INTO ledger_ranges (sequence, data) VALUES (?, ?)',
    sequence,
    JSON.stringify(range),
  );
}

function insertScan(
  storage: DurableObjectStorage,
  partId: string,
  checkpoint: LedgerCommit['scan']['checkpoint'],
): void {
  storage.sql.exec(
    'INSERT INTO ledger_scans (part_id, data) VALUES (?, ?) ON CONFLICT(part_id) DO UPDATE SET data = excluded.data',
    partId,
    JSON.stringify({ checkpoint }),
  );
}

function insertFingerprints(
  storage: DurableObjectStorage,
  partId: string,
  startIndex: number,
  fingerprints: SourceFingerprint[],
): void {
  fingerprints.forEach((fingerprint, index) => {
    storage.sql.exec(
      'INSERT INTO ledger_scan_fingerprints (part_id, fingerprint_index, data) VALUES (?, ?, ?)',
      partId,
      startIndex + index,
      JSON.stringify(fingerprint),
    );
  });
}

type StateMetadata = Record<string, unknown>;

function readMetadata(storage: DurableObjectStorage): StateMetadata {
  const row = [
    ...storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
  ][0];
  if (!row) return {};
  try {
    const metadata: unknown = JSON.parse(row.data);
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new Error('metadata is not an object');
    }
    return metadata as StateMetadata;
  } catch {
    throw new ArchiveContractError('ledger_state_corrupt');
  }
}

function requiredCount(metadata: StateMetadata, field: string): number {
  const value = metadata[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ArchiveContractError('ledger_state_corrupt');
  }
  return value as number;
}

function requiredDigest(metadata: StateMetadata, field: string): string {
  const value = metadata[field];
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new ArchiveContractError('ledger_state_corrupt');
  }
  return value;
}

function parseScan(data: string): ScanState {
  try {
    const scan = JSON.parse(data) as { checkpoint: ScanState['checkpoint'] };
    return { checkpoint: scan.checkpoint };
  } catch {
    throw new ArchiveContractError('ledger_state_corrupt');
  }
}

export function readLedgerScan(
  storage: DurableObjectStorage,
  partId: string,
): ScanState | undefined {
  const row = [
    ...storage.sql.exec<{ data: string }>(
      'SELECT data FROM ledger_scans WHERE part_id = ?',
      partId,
    ),
  ][0];
  return row ? parseScan(row.data) : undefined;
}

export function readLedgerSnapshot(storage: DurableObjectStorage): LedgerSnapshot {
  ensureLedgerTables(storage);
  const metadata = readMetadata(storage);
  if (Object.keys(metadata).length === 0) {
    return {
      elementCount: 0,
      recordCount: 0,
      chainHead: GENESIS_CHAIN_HASH,
      generation: 0,
    };
  }
  return {
    scope: metadata.scope as LedgerSnapshot['scope'],
    keyVersion: metadata.keyVersion as LedgerSnapshot['keyVersion'],
    elementCount: requiredCount(metadata, 'elementCount'),
    recordCount: requiredCount(metadata, 'recordCount'),
    chainHead: requiredDigest(metadata, 'chainHead'),
    generation: requiredCount(metadata, 'generation'),
    manifestKey: metadata.manifestKey as LedgerSnapshot['manifestKey'],
    manifestHeadPageKey: metadata.manifestHeadPageKey as LedgerSnapshot['manifestHeadPageKey'],
  };
}

export function persistLedgerCommit(storage: DurableObjectStorage, commit: LedgerCommit): void {
  ensureLedgerTables(storage);
  storage.sql.exec(
    'INSERT INTO ledger_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    stateMetadata(commit),
  );
  for (const element of commit.newElements) insertElement(storage, element);
  for (const [sequence, range] of Object.entries(commit.ranges)) {
    insertRange(storage, Number(sequence), range);
  }
  if (commit.scan.replace) {
    storage.sql.exec('DELETE FROM ledger_scan_fingerprints WHERE part_id = ?', commit.scan.partId);
  }
  insertScan(storage, commit.scan.partId, commit.scan.checkpoint);
  const startIndex = commit.scan.replace
    ? 0
    : ([
        ...storage.sql.exec<{ next_index: number }>(
          'SELECT COALESCE(MAX(fingerprint_index) + 1, 0) AS next_index FROM ledger_scan_fingerprints WHERE part_id = ?',
          commit.scan.partId,
        ),
      ][0]?.next_index ?? 0);
  insertFingerprints(storage, commit.scan.partId, startIndex, commit.scan.fingerprints);
}
