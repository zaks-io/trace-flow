import { decryptArchiveObject, type ArchiveObjectEnvelope } from '@trace-flow/utils';
import {
  ArchiveContractError,
  GENESIS_CHAIN_HASH,
  MAX_CHUNK_BYTES,
  MAX_MANIFEST_BYTES,
  digestString,
  payloadBytes,
  assertDigest,
  assertIdentifier,
  assertSafeInteger,
  type ArchiveScope,
  type ArchiveSessionManifest,
  type ArchiveSessionManifestPage,
  type ChunkByteRange,
  type LedgerElement,
  type ManifestElement,
  type StoredElement,
} from './archive-contract';
import { assertPlannedChain, canonicalElement } from './archive-chain';
import { MAX_ENCRYPTED_ARCHIVE_OBJECT_BYTES } from './archive-key-reencryption';
import { archiveObjectKey } from './archive-storage-key';
import type { ArchiveRepairStateExpectation, LedgerSnapshot } from './archive-ledger-state';
import { readLedgerScan, readLedgerSnapshot } from './archive-ledger-storage';
import { readArchiveRepair } from './archive-ledger-repair';
import { hasPendingIntent } from './archive-ledger-intent';

const MAX_LEDGER_ELEMENTS_PER_PAGE = 64;
const MAX_MANIFEST_OBJECTS_PER_PAGE = 4;
const MAX_VERIFICATION_BYTES_PER_PAGE = 32 * 1024 * 1024;

export type ArchiveVerificationPhase = 'before' | 'after';

interface VerificationProgress {
  operationId: string;
  snapshotSha256: string;
  phase: ArchiveVerificationPhase;
  expected: ArchiveRepairStateExpectation;
  stage: 'ledger' | 'manifest' | 'complete';
  nextSequence: number;
  chainHead: string;
  verifiedRecords: number;
  verifiedManifestObjects: number;
}

type ManifestObjectExpectation =
  | { kind: 'root' }
  | { kind: 'page'; elementStart: number; elementCount: number }
  | { kind: 'history'; cumulativeElementCount: number };

export interface ArchiveVerificationInput {
  operationId: string;
  snapshotSha256: string;
  phase: ArchiveVerificationPhase;
  expected: ArchiveRepairStateExpectation;
  limit?: number;
}

export interface ArchiveVerificationResult {
  operationId: string;
  snapshotSha256: string;
  phase: ArchiveVerificationPhase;
  status: VerificationProgress['stage'];
  nextSequence: number;
  elementCount: number;
  recordCount: number;
  chainHead: string;
  verifiedManifestObjects: number;
  generation: number;
}

type ResolveKey = (keyVersion: number) => Promise<CryptoKey>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameState(actual: LedgerSnapshot, expected: ArchiveRepairStateExpectation): boolean {
  return (
    actual.generation === expected.generation &&
    actual.elementCount === expected.elementCount &&
    actual.recordCount === expected.recordCount &&
    actual.chainHead === expected.chainHead
  );
}

export function ensureArchiveVerificationTables(storage: DurableObjectStorage): void {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS ledger_verifications (operation_id TEXT NOT NULL, phase TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (operation_id, phase))',
  );
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS ledger_verification_objects (operation_id TEXT NOT NULL, phase TEXT NOT NULL, object_key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (operation_id, phase, object_key))',
  );
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS ledger_verification_manifest_elements (operation_id TEXT NOT NULL, phase TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY (operation_id, phase, sequence))',
  );
}

function readProgress(
  storage: DurableObjectStorage,
  operationId: string,
  phase: ArchiveVerificationPhase,
): VerificationProgress | null {
  ensureArchiveVerificationTables(storage);
  const row = [
    ...storage.sql.exec<{ data: string }>(
      'SELECT data FROM ledger_verifications WHERE operation_id = ? AND phase = ?',
      operationId,
      phase,
    ),
  ][0];
  if (!row) return null;
  try {
    return JSON.parse(row.data) as VerificationProgress;
  } catch {
    throw new ArchiveContractError('archive_verification_corrupt');
  }
}

function assertInputMatches(progress: VerificationProgress, input: ArchiveVerificationInput): void {
  if (
    progress.snapshotSha256 !== input.snapshotSha256 ||
    JSON.stringify(progress.expected) !== JSON.stringify(input.expected)
  ) {
    throw new ArchiveContractError('archive_verification_snapshot_mismatch');
  }
}

function writeProgress(storage: DurableObjectStorage, progress: VerificationProgress): void {
  storage.sql.exec(
    'INSERT INTO ledger_verifications (operation_id, phase, snapshot_sha256, status, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(operation_id, phase) DO UPDATE SET status = excluded.status, data = excluded.data',
    progress.operationId,
    progress.phase,
    progress.snapshotSha256,
    progress.stage,
    JSON.stringify(progress),
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return digestString(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function boundedDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CHUNK_BYTES)
        throw new ArchiveContractError('archive_verification_object_invalid');
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new ArchiveContractError('archive_verification_object_invalid');
  }
  const plaintext = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    plaintext.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return plaintext;
}

async function readDecryptedObject(
  bucket: R2Bucket,
  scope: ArchiveScope,
  objectKey: string,
  objectClass: 'chunk' | 'manifest',
  resolveKey: ResolveKey,
): Promise<{ plaintext: Uint8Array; encryptedBytes: number }> {
  const head = await bucket.head(objectKey);
  if (!head || head.size > MAX_ENCRYPTED_ARCHIVE_OBJECT_BYTES) {
    throw new ArchiveContractError('archive_verification_object_invalid');
  }
  const object = await bucket.get(objectKey);
  if (object?.size !== head.size) {
    throw new ArchiveContractError('archive_verification_object_invalid');
  }
  try {
    const envelope = JSON.parse(await object.text()) as ArchiveObjectEnvelope;
    if (!Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1) throw new Error();
    const decrypted = await decryptArchiveObject(envelope, {
      key: await resolveKey(envelope.keyVersion),
      orgId: scope.orgId,
      objectKey,
      objectClass,
      keyVersion: envelope.keyVersion,
    });
    const plaintext = objectClass === 'chunk' ? await boundedDecompress(decrypted) : decrypted;
    const max = objectClass === 'chunk' ? MAX_CHUNK_BYTES : MAX_MANIFEST_BYTES;
    if (plaintext.byteLength > max) throw new Error();
    const digest = await sha256(plaintext);
    if (
      (await archiveObjectKey(scope, objectClass === 'chunk' ? 'chunks' : 'manifests', digest)) !==
      objectKey
    ) {
      throw new Error();
    }
    return { plaintext, encryptedBytes: head.size };
  } catch {
    throw new ArchiveContractError('archive_verification_object_invalid');
  }
}

function parseLedgerRow(row: { element_data: string; range_data: string }): {
  element: LedgerElement;
  range: ChunkByteRange;
} {
  try {
    return {
      element: JSON.parse(row.element_data) as LedgerElement,
      range: JSON.parse(row.range_data) as ChunkByteRange,
    };
  } catch {
    throw new ArchiveContractError('archive_verification_ledger_invalid');
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyStoredElement(
  storage: DurableObjectStorage,
  expected: LedgerElement,
  range: ChunkByteRange,
  chunk: Uint8Array,
): Promise<void> {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start ||
    range.end > chunk.byteLength
  ) {
    throw new ArchiveContractError('archive_verification_ledger_invalid');
  }
  const bytes = chunk.slice(range.start, range.end);
  if (bytes.at(-1) !== 0x0a) throw new ArchiveContractError('archive_verification_payload_invalid');
  let stored: StoredElement;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.slice(0, -1)),
    );
    if (!isRecord(parsed) || (parsed.kind !== 'record' && parsed.kind !== 'checkpoint')) {
      throw new Error();
    }
    stored = parsed as unknown as StoredElement;
  } catch {
    throw new ArchiveContractError('archive_verification_payload_invalid');
  }
  if (!equalBytes(new TextEncoder().encode(`${canonicalElement(stored)}\n`), bytes)) {
    throw new ArchiveContractError('archive_verification_payload_invalid');
  }
  if (stored.kind === 'record' && expected.kind === 'record') {
    if ((await sha256(payloadBytes(stored))) !== stored.content_sha256) {
      throw new ArchiveContractError('archive_verification_payload_invalid');
    }
    const { payload: _payload, ...metadata } = stored;
    if (!equalJson(metadata, expected)) {
      throw new ArchiveContractError('archive_verification_ledger_invalid');
    }
    const version = [
      ...storage.sql.exec<{ sequence: number }>(
        'SELECT sequence FROM ledger_record_versions WHERE version_key = ?',
        JSON.stringify([
          stored.source_transcript_part_id,
          stored.source_record_identity,
          stored.content_sha256,
        ]),
      ),
    ][0];
    if (version?.sequence !== stored.chain_sequence) {
      throw new ArchiveContractError('archive_verification_ledger_invalid');
    }
  } else if (!equalJson(stored, expected)) {
    throw new ArchiveContractError('archive_verification_ledger_invalid');
  }
}

function manifestElementFor(element: LedgerElement, range: ChunkByteRange): ManifestElement {
  return element.kind === 'record'
    ? {
        element_type: 'record',
        chain_sequence: element.chain_sequence,
        source_transcript_part_id: element.source_transcript_part_id,
        source_record_identity: element.source_record_identity,
        content_sha256: element.content_sha256,
        chain_hash: element.chain_hash,
        byte_range: range,
      }
    : {
        element_type: 'checkpoint',
        chain_sequence: element.chain_sequence,
        checkpoint: element.checkpoint,
        chain_hash: element.chain_hash,
        byte_range: range,
      };
}

function verifyManifestElements(
  storage: DurableObjectStorage,
  progress: VerificationProgress,
  elements: ManifestElement[],
): void {
  for (const item of elements) {
    const row = [
      ...storage.sql.exec<{ element_data: string; range_data: string }>(
        'SELECT e.data AS element_data, r.data AS range_data FROM ledger_elements e JOIN ledger_ranges r ON r.sequence = e.sequence WHERE e.sequence = ?',
        item.chain_sequence,
      ),
    ][0];
    if (!row) throw new ArchiveContractError('archive_verification_manifest_invalid');
    const { element, range } = parseLedgerRow(row);
    if (!equalJson(manifestElementFor(element, range), item)) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    storage.sql.exec(
      'INSERT OR IGNORE INTO ledger_verification_manifest_elements (operation_id, phase, sequence) VALUES (?, ?, ?)',
      progress.operationId,
      progress.phase,
      item.chain_sequence,
    );
  }
}

function enqueueManifestReference(
  storage: DurableObjectStorage,
  progress: VerificationProgress,
  objectKey: string,
  expected: ManifestObjectExpectation,
): void {
  const serialized = JSON.stringify(expected);
  const existing = [
    ...storage.sql.exec<{ data: string }>(
      'SELECT data FROM ledger_verification_objects WHERE operation_id = ? AND phase = ? AND object_key = ?',
      progress.operationId,
      progress.phase,
      objectKey,
    ),
  ][0];
  if (existing) {
    if (existing.data !== serialized) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    return;
  }
  storage.sql.exec(
    "INSERT INTO ledger_verification_objects (operation_id, phase, object_key, status, data) VALUES (?, ?, ?, 'pending', ?)",
    progress.operationId,
    progress.phase,
    objectKey,
    serialized,
  );
}

function verifyManifestShape(
  storage: DurableObjectStorage,
  scope: ArchiveScope,
  state: LedgerSnapshot,
  progress: VerificationProgress,
  objectKey: string,
  value: ArchiveSessionManifest | ArchiveSessionManifestPage,
  expectedObject: ManifestObjectExpectation,
): void {
  if (
    value.archive_format_version !== 1 ||
    value.chain_hash_version !== 1 ||
    value.source !== scope.source ||
    value.source_session_id !== scope.sourceSessionId ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    value.generation > progress.expected.generation ||
    !!value.elements === !!value.pages
  ) {
    throw new ArchiveContractError('archive_verification_manifest_invalid');
  }
  const isCurrentRoot = objectKey === state.manifestKey;
  const isRootShape =
    'chain_head' in value && typeof value.chain_head === 'string' && !('element_start' in value);
  if (
    (expectedObject.kind === 'root' && (!isCurrentRoot || !isRootShape)) ||
    (expectedObject.kind !== 'root' && isCurrentRoot)
  ) {
    throw new ArchiveContractError('archive_verification_manifest_invalid');
  }
  const page = isRootShape ? undefined : (value as ArchiveSessionManifestPage);
  if (isRootShape) {
    const root = value;
    if (expectedObject.kind === 'page') {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    const historicalChainHead =
      expectedObject.kind === 'history'
        ? [
            ...storage.sql.exec<{ data: string }>(
              'SELECT data FROM ledger_elements WHERE sequence = ?',
              expectedObject.cumulativeElementCount - 1,
            ),
          ][0]
        : undefined;
    let expectedHistoricalChainHead: string | undefined;
    if (historicalChainHead) {
      try {
        const historicalElement = JSON.parse(historicalChainHead.data) as LedgerElement;
        expectedHistoricalChainHead = historicalElement.chain_hash;
      } catch {
        throw new ArchiveContractError('archive_verification_ledger_invalid');
      }
    }
    if (
      (expectedObject.kind === 'root' &&
        (root.generation !== progress.expected.generation ||
          root.element_count !== progress.expected.elementCount ||
          root.chain_head !== progress.expected.chainHead)) ||
      (expectedObject.kind === 'history' &&
        (root.element_count !== expectedObject.cumulativeElementCount ||
          root.chain_head !== expectedHistoricalChainHead))
    ) {
      throw new ArchiveContractError('archive_verification_snapshot_mismatch');
    }
  } else {
    if (!page) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    if (
      !Number.isSafeInteger(page.element_start) ||
      !Number.isSafeInteger(page.element_count) ||
      page.element_start < 0 ||
      page.element_count < 1 ||
      page.element_start + page.element_count > progress.expected.elementCount
    ) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    if (
      (expectedObject.kind === 'page' &&
        (page.element_start !== expectedObject.elementStart ||
          page.element_count !== expectedObject.elementCount)) ||
      (expectedObject.kind === 'history' &&
        page.element_start + page.element_count !== expectedObject.cumulativeElementCount)
    ) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
  }
  if (value.elements) {
    const start = page?.element_start ?? 0;
    const count = value.element_count;
    if (
      value.elements.length !== count ||
      value.elements.some((item, index) => item.chain_sequence !== start + index)
    ) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    verifyManifestElements(storage, progress, value.elements);
  }
  if (value.pages) {
    if (value.pages.length < 1 || value.pages.length > 128) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    let nextStart = page?.element_start ?? 0;
    for (const reference of value.pages) {
      if (
        typeof reference.page_key !== 'string' ||
        !Number.isSafeInteger(reference.element_start) ||
        !Number.isSafeInteger(reference.element_count) ||
        reference.element_start < 0 ||
        reference.element_count < 1 ||
        reference.element_start + reference.element_count > progress.expected.elementCount
      ) {
        throw new ArchiveContractError('archive_verification_manifest_invalid');
      }
      if (reference.element_start !== nextStart) {
        throw new ArchiveContractError('archive_verification_manifest_invalid');
      }
      nextStart += reference.element_count;
      const childExpectation: ManifestObjectExpectation = isRootShape
        ? {
            kind: 'history',
            cumulativeElementCount: reference.element_start + reference.element_count,
          }
        : {
            kind: 'page',
            elementStart: reference.element_start,
            elementCount: reference.element_count,
          };
      enqueueManifestReference(storage, progress, reference.page_key, childExpectation);
    }
    const expectedEnd = page ? page.element_start + page.element_count : value.element_count;
    if (nextStart !== expectedEnd) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
  }
  if (value.previous_page_key) {
    if (!page || page.element_start < 1) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    enqueueManifestReference(storage, progress, value.previous_page_key, {
      kind: 'history',
      cumulativeElementCount: page.element_start,
    });
  }
}

async function verifyLedgerPage(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  scope: ArchiveScope,
  progress: VerificationProgress,
  limit: number,
  resolveKey: ResolveKey,
): Promise<void> {
  const rows = [
    ...storage.sql.exec<{ element_data: string; range_data: string }>(
      'SELECT e.data AS element_data, r.data AS range_data FROM ledger_elements e JOIN ledger_ranges r ON r.sequence = e.sequence WHERE e.sequence >= ? ORDER BY e.sequence LIMIT ?',
      progress.nextSequence,
      limit,
    ),
  ];
  if (rows.length === 0 && progress.nextSequence < progress.expected.elementCount) {
    throw new ArchiveContractError('archive_verification_ledger_invalid');
  }
  let retainedChunkId: string | undefined;
  let retainedChunk: Uint8Array | undefined;
  let processedPlaintextBytes = 0;
  let processed = 0;
  for (const row of rows) {
    const { element, range } = parseLedgerRow(row);
    if (element.chain_sequence !== progress.nextSequence + processed) {
      throw new ArchiveContractError('archive_verification_ledger_invalid');
    }
    let chunk = range.chunk_id === retainedChunkId ? retainedChunk : undefined;
    if (!chunk) {
      if (
        processed > 0 &&
        Number.isSafeInteger(range.end) &&
        range.end > MAX_VERIFICATION_BYTES_PER_PAGE - processedPlaintextBytes
      ) {
        break;
      }
      const key = await archiveObjectKey(scope, 'chunks', `sha256:${range.chunk_id}`);
      const decrypted = await readDecryptedObject(bucket, scope, key, 'chunk', resolveKey);
      if (
        processed > 0 &&
        processedPlaintextBytes + decrypted.plaintext.byteLength > MAX_VERIFICATION_BYTES_PER_PAGE
      ) {
        break;
      }
      processedPlaintextBytes += decrypted.plaintext.byteLength;
      chunk = decrypted.plaintext;
      retainedChunkId = range.chunk_id;
      retainedChunk = chunk;
    }
    await assertPlannedChain(progress.chainHead, element.chain_sequence, [element]);
    await verifyStoredElement(storage, element, range, chunk);
    progress.chainHead = element.chain_hash;
    if (element.kind === 'record') progress.verifiedRecords += 1;
    processed += 1;
  }
  if (processed === 0 && rows.length > 0)
    throw new ArchiveContractError('archive_verification_cap_exceeded');
  progress.nextSequence += processed;
  if (progress.nextSequence === progress.expected.elementCount) {
    if (
      progress.chainHead !== progress.expected.chainHead ||
      progress.verifiedRecords !== progress.expected.recordCount
    ) {
      throw new ArchiveContractError('archive_verification_ledger_invalid');
    }
    progress.stage = 'manifest';
  }
}

async function verifyManifestPage(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  scope: ArchiveScope,
  state: LedgerSnapshot,
  progress: VerificationProgress,
  resolveKey: ResolveKey,
): Promise<void> {
  if (!state.manifestKey) throw new ArchiveContractError('archive_verification_manifest_invalid');
  const pending = [
    ...storage.sql.exec<{ object_key: string; data: string }>(
      "SELECT object_key, data FROM ledger_verification_objects WHERE operation_id = ? AND phase = ? AND status = 'pending' ORDER BY object_key LIMIT ?",
      progress.operationId,
      progress.phase,
      MAX_MANIFEST_OBJECTS_PER_PAGE,
    ),
  ];
  let consumedBytes = 0;
  for (const row of pending) {
    const decrypted = await readDecryptedObject(
      bucket,
      scope,
      row.object_key,
      'manifest',
      resolveKey,
    );
    if (
      consumedBytes > 0 &&
      consumedBytes + decrypted.encryptedBytes > MAX_VERIFICATION_BYTES_PER_PAGE
    )
      break;
    consumedBytes += decrypted.encryptedBytes;
    let value: ArchiveSessionManifest | ArchiveSessionManifestPage;
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decrypted.plaintext),
      );
      if (!isRecord(parsed)) throw new Error();
      value = parsed as unknown as ArchiveSessionManifest | ArchiveSessionManifestPage;
    } catch {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    let expectedObject: ManifestObjectExpectation;
    try {
      expectedObject = JSON.parse(row.data) as ManifestObjectExpectation;
    } catch {
      throw new ArchiveContractError('archive_verification_corrupt');
    }
    verifyManifestShape(storage, scope, state, progress, row.object_key, value, expectedObject);
    storage.sql.exec(
      "UPDATE ledger_verification_objects SET status = 'verified' WHERE operation_id = ? AND phase = ? AND object_key = ? AND status = 'pending'",
      progress.operationId,
      progress.phase,
      row.object_key,
    );
    progress.verifiedManifestObjects += 1;
  }
  progress.verifiedManifestObjects =
    [
      ...storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM ledger_verification_objects WHERE operation_id = ? AND phase = ? AND status = 'verified'",
        progress.operationId,
        progress.phase,
      ),
    ][0]?.count ?? 0;
  const remaining = [
    ...storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ledger_verification_objects WHERE operation_id = ? AND phase = ? AND status = 'pending'",
      progress.operationId,
      progress.phase,
    ),
  ][0]?.count;
  if (remaining === 0) {
    const covered = [
      ...storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM ledger_verification_manifest_elements WHERE operation_id = ? AND phase = ?',
        progress.operationId,
        progress.phase,
      ),
    ][0]?.count;
    if (covered !== progress.expected.elementCount) {
      throw new ArchiveContractError('archive_verification_manifest_invalid');
    }
    progress.stage = 'complete';
  }
}

export async function verifyArchiveLedgerPage(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  scope: ArchiveScope,
  input: ArchiveVerificationInput,
  resolveKey: ResolveKey,
): Promise<ArchiveVerificationResult> {
  if (
    (input.phase !== 'before' && input.phase !== 'after') ||
    typeof input.expected !== 'object' ||
    input.expected === null
  ) {
    throw new ArchiveContractError('archive_verification_invalid');
  }
  assertIdentifier(input.operationId, 'archive_verification_invalid');
  assertDigest(input.snapshotSha256, 'archive_verification_invalid');
  for (const value of [
    input.expected.generation,
    input.expected.elementCount,
    input.expected.recordCount,
  ]) {
    assertSafeInteger(value, 'archive_verification_invalid');
  }
  assertDigest(input.expected.chainHead, 'archive_verification_invalid');
  const state = readLedgerSnapshot(storage);
  if (!state.scope || !equalJson(state.scope, scope) || !sameState(state, input.expected)) {
    throw new ArchiveContractError('archive_verification_snapshot_mismatch');
  }
  const repair = readArchiveRepair(storage, input.operationId);
  if (
    input.phase === 'after' &&
    (repair?.status !== 'active' ||
      repair.plan.snapshotSha256 !== input.snapshotSha256 ||
      repair.appliedChunks !== repair.plan.chunkDigests.length ||
      hasPendingIntent(storage) ||
      !equalJson(
        readLedgerScan(storage, repair.plan.partId)?.checkpoint,
        repair.plan.finalCheckpoint,
      ))
  ) {
    throw new ArchiveContractError('archive_verification_invalid');
  }
  let progress = readProgress(storage, input.operationId, input.phase);
  if (!progress) {
    progress = {
      operationId: input.operationId,
      snapshotSha256: input.snapshotSha256,
      phase: input.phase,
      expected: input.expected,
      stage: 'ledger',
      nextSequence: 0,
      chainHead: GENESIS_CHAIN_HASH,
      verifiedRecords: 0,
      verifiedManifestObjects: 0,
    };
    storage.transactionSync(() => {
      writeProgress(storage, progress!);
      if (!state.manifestKey)
        throw new ArchiveContractError('archive_verification_manifest_invalid');
      enqueueManifestReference(storage, progress!, state.manifestKey, { kind: 'root' });
    });
  } else {
    assertInputMatches(progress, input);
  }
  if (progress.stage === 'ledger') {
    const limit = input.limit ?? MAX_LEDGER_ELEMENTS_PER_PAGE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEDGER_ELEMENTS_PER_PAGE) {
      throw new ArchiveContractError('archive_verification_invalid');
    }
    await verifyLedgerPage(storage, bucket, scope, progress, limit, resolveKey);
  } else if (progress.stage === 'manifest') {
    await verifyManifestPage(storage, bucket, scope, state, progress, resolveKey);
  }
  writeProgress(storage, progress);
  return {
    operationId: progress.operationId,
    snapshotSha256: progress.snapshotSha256,
    phase: progress.phase,
    status: progress.stage,
    nextSequence: progress.nextSequence,
    elementCount: progress.expected.elementCount,
    recordCount: progress.verifiedRecords,
    chainHead: progress.chainHead,
    verifiedManifestObjects: progress.verifiedManifestObjects,
    generation: progress.expected.generation,
  };
}

export function assertArchiveVerificationComplete(
  storage: DurableObjectStorage,
  operationId: string,
  phase: ArchiveVerificationPhase,
  snapshotSha256: string,
  expected: ArchiveRepairStateExpectation,
): void {
  const progress = readProgress(storage, operationId, phase);
  if (!progress) throw new ArchiveContractError('archive_verification_required');
  assertInputMatches(progress, { operationId, phase, snapshotSha256, expected });
  const pendingObjects = [
    ...storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ledger_verification_objects WHERE operation_id = ? AND phase = ? AND status != 'verified'",
      operationId,
      phase,
    ),
  ][0]?.count;
  const verifiedObjects = [
    ...storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ledger_verification_objects WHERE operation_id = ? AND phase = ? AND status = 'verified'",
      operationId,
      phase,
    ),
  ][0]?.count;
  const coveredElements = [
    ...storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM ledger_verification_manifest_elements WHERE operation_id = ? AND phase = ?',
      operationId,
      phase,
    ),
  ][0]?.count;
  if (
    progress.stage !== 'complete' ||
    progress.nextSequence !== expected.elementCount ||
    progress.verifiedRecords !== expected.recordCount ||
    progress.chainHead !== expected.chainHead ||
    pendingObjects !== 0 ||
    !verifiedObjects ||
    coveredElements !== expected.elementCount
  ) {
    throw new ArchiveContractError('archive_verification_required');
  }
}
