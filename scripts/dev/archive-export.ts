import { strict as assert } from 'node:assert';
import { createHash, type Hash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  GENESIS_CHAIN_HASH,
  MAX_ARCHIVE_EXPORT_ORGANIZATION_BATCH_SESSIONS,
  digestString,
  payloadBytes,
  type ManifestElement,
  type StoredElement,
} from '../../apps/archive-api/src/archive-contract';
import { checkpointChainHash, recordChainHash } from '../../apps/archive-api/src/archive-chain';
import { collectExportManifestGraph } from './archive-export-traversal';
import {
  exportSessionDirectoryId,
  latestSidecarGenerations,
  RawPartVerifier,
} from './archive-export-verification';

const grantArg = process.env.TRACE_FLOW_ARCHIVE_EXPORT_GRANT;
const [archiveUrlArg, outputArg] = process.argv.slice(2);
if (!grantArg || !archiveUrlArg || !outputArg) {
  throw new Error(
    'Usage: TRACE_FLOW_ARCHIVE_EXPORT_GRANT=<grant> bun scripts/dev/archive-export.ts <archive-url> <output-directory>',
  );
}
const grant = grantArg;
const archiveUrl = archiveUrlArg.replace(/\/$/u, '');
const outputDirectory = resolve(outputArg);
const selectionPath = resolve(outputDirectory, 'archive-manifest.json');
const progressPath = resolve(outputDirectory, '.archive-export-progress.sqlite');

type Json = Record<string, unknown>;
interface Selection {
  version: 1;
  exportId: string;
  orgId: string;
  sessions: {
    userId: string;
    contributionId: string;
    source: 'claude' | 'codex';
    sourceSessionId: string;
    manifestKey: string;
    manifestHeadPageKey: string;
    generation: number;
    elementCount: number;
    recordCount: number;
    chainHead: string;
  }[];
  selectionSha256: string;
  selectionToken: string;
}
interface LocalManifest {
  selection: Pick<Selection, 'version' | 'exportId' | 'orgId' | 'sessions'> &
    Partial<Pick<Selection, 'selectionSha256' | 'selectionToken'>>;
  batches: { sessionStart: number; selection: Selection }[];
  sessions: { session_index: number; status: 'pending' | 'verified' | 'failed' }[];
}

function batchFor(
  manifest: LocalManifest,
  index: number,
): {
  selection: Selection;
  sessionIndex: number;
} {
  let batch: LocalManifest['batches'][number] | undefined;
  for (const candidate of manifest.batches) {
    if (candidate.sessionStart > index) break;
    batch = candidate;
  }
  assert.ok(batch && index < batch.sessionStart + batch.selection.sessions.length);
  return { selection: batch.selection, sessionIndex: index - batch.sessionStart };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return digestString(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function call(body: Json): Promise<Json> {
  const response = await fetch(`${archiveUrl}/v1/archive/exports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Flow-Archive-Export-Grant': grant,
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Json;
  if (!response.ok) throw new Error(`Archive export failed with HTTP ${response.status}`);
  return result;
}

async function listSessions(): Promise<Json[]> {
  const sessions: Json[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${archiveUrl}/v1/archive/sessions`);
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, {
      headers: { 'X-Trace-Flow-Archive-Export-Grant': grant },
    });
    const result = (await response.json()) as Json;
    if (!response.ok)
      throw new Error(`Archive session listing failed with HTTP ${response.status}`);
    assert.ok(Array.isArray(result.sessions));
    sessions.push(...(result.sessions as Json[]));
    cursor = typeof result.cursor === 'string' ? result.cursor : undefined;
  } while (cursor);
  return sessions;
}

async function existingManifest(): Promise<LocalManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(selectionPath, 'utf8')) as LocalManifest;
    assert.ok(parsed.selection);
    assert.ok(Array.isArray(parsed.sessions));
    if (!Array.isArray(parsed.batches)) {
      assert.notEqual(
        exportScope(),
        'organization',
        'Organization export manifest lacks signed batches',
      );
      await validateSelection(parsed.selection as Selection);
      parsed.batches = [{ sessionStart: 0, selection: parsed.selection as Selection }];
    }
    await validateManifest(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function validateSelection(selection: Selection): Promise<void> {
  const { selectionSha256, selectionToken, ...unsigned } = selection;
  assert.match(selectionToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(
    await sha256(new TextEncoder().encode(JSON.stringify(unsigned))),
    selectionSha256,
    'Selection hash mismatch',
  );
}

async function validateManifest(manifest: LocalManifest): Promise<void> {
  assert.equal(manifest.selection.version, 1);
  assert.ok(Array.isArray(manifest.selection.sessions));
  assert.equal(manifest.sessions.length, manifest.selection.sessions.length);
  assert.ok(manifest.batches.length > 0);
  let sessionStart = 0;
  for (const batch of manifest.batches) {
    assert.equal(batch.sessionStart, sessionStart, 'Export batches must be contiguous');
    await validateSelection(batch.selection);
    if (exportScope() === 'organization') {
      assert.ok(
        batch.selection.sessions.length <= MAX_ARCHIVE_EXPORT_ORGANIZATION_BATCH_SESSIONS,
        'Export batch exceeds session limit',
      );
    }
    assert.equal(batch.selection.exportId, manifest.selection.exportId);
    assert.equal(batch.selection.orgId, manifest.selection.orgId);
    for (const session of batch.selection.sessions) {
      assert.deepEqual(session, manifest.selection.sessions[sessionStart]);
      sessionStart++;
    }
  }
  assert.equal(sessionStart, manifest.selection.sessions.length);
  for (const [index, status] of manifest.sessions.entries()) {
    assert.equal(status.session_index, index);
    assert.ok(['pending', 'verified', 'failed'].includes(status.status));
  }
}

function decodeBase64(value: unknown): Uint8Array {
  assert.ok(typeof value === 'string');
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function safePartName(partId: string): Promise<string> {
  return sha256(new TextEncoder().encode(partId)).then((value) => value.slice(7));
}

function safeRelativePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  assert.ok(typeof value === 'string');
  assert.ok(!isAbsolute(value));
  assert.match(value, /^tool-results\/[^/\\\0]+$/u);
  assert.ok(!value.split('/').includes('..'));
  return value;
}

function openProgress(): Database {
  const database = new Database(progressPath, { create: true });
  database.exec('PRAGMA journal_mode = WAL');
  database.exec(
    'CREATE TABLE IF NOT EXISTS elements (session_index INTEGER NOT NULL, sequence INTEGER NOT NULL, element TEXT NOT NULL, PRIMARY KEY(session_index, sequence))',
  );
  return database;
}

async function collectManifestElements(
  database: Database,
  manifest: LocalManifest,
  globalIndex: number,
): Promise<void> {
  const { selection, sessionIndex } = batchFor(manifest, globalIndex);
  const session = selection.sessions[sessionIndex]!;
  const insertElement = database.query(
    'INSERT OR REPLACE INTO elements (session_index, sequence, element) VALUES (?, ?, ?)',
  );
  await collectExportManifestGraph<Json>(
    session.manifestKey,
    async (objectKey) => {
      const response = await call({
        operation: 'manifest',
        selection,
        sessionIndex,
        objectKey,
      });
      return response.manifest as {
        elements?: Json[];
        pages?: { page_key: string }[];
        previous_page_key?: string;
      };
    },
    (elements) => {
      for (const element of elements) {
        const row = element;
        assert.ok(
          typeof row.chain_sequence === 'number' && Number.isSafeInteger(row.chain_sequence),
        );
        insertElement.run(globalIndex, row.chain_sequence, JSON.stringify(row));
      }
    },
  );
}

function parseStoredElement(chunk: Uint8Array, manifest: Json): StoredElement {
  const range = manifest.byte_range as Json;
  assert.ok(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end));
  const start = range.start as number;
  const end = range.end as number;
  assert.ok(start >= 0 && end > start && end <= chunk.byteLength);
  const line = new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(start, end));
  assert.ok(line.endsWith('\n'));
  const element = JSON.parse(line.slice(0, -1)) as StoredElement;
  assert.equal(element.chain_sequence, manifest.chain_sequence);
  assert.equal(element.chain_hash, manifest.chain_hash);
  assert.equal(element.kind === 'record' ? 'record' : 'checkpoint', manifest.element_type);
  if (element.kind === 'record') {
    assert.equal(element.source_transcript_part_id, manifest.source_transcript_part_id);
    assert.equal(element.source_record_identity, manifest.source_record_identity);
    assert.equal(element.content_sha256, manifest.content_sha256);
  }
  return element;
}

async function writeSession(
  database: Database,
  manifest: LocalManifest,
  globalIndex: number,
): Promise<void> {
  const { selection, sessionIndex } = batchFor(manifest, globalIndex);
  const session = selection.sessions[sessionIndex]!;
  const sessionDirectory = resolve(
    outputDirectory,
    'sessions',
    session.source,
    await exportSessionDirectoryId(session.contributionId, session.sourceSessionId),
  );
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(resolve(sessionDirectory, 'parts'), { recursive: true });
  const rows = database
    .query<
      { element: string },
      [number]
    >('SELECT element FROM elements WHERE session_index = ? ORDER BY sequence')
    .iterate(globalIndex);
  let previous = GENESIS_CHAIN_HASH;
  let count = 0;
  let recordCount = 0;
  let cachedChunkId = '';
  let cachedChunk: Uint8Array = new Uint8Array();
  const legacyParts = new Map<
    string,
    { file: string; hash: Hash; byteLength: number; initialized: boolean }
  >();
  const rawParts = new Map<
    string,
    {
      file: string;
      verifier: RawPartVerifier;
      initialized: boolean;
      relativePath?: string;
      firstObservedAt: number;
      checkpointSequence: number;
    }
  >();
  const parts: Json[] = [];

  for (const row of rows) {
    const manifest = JSON.parse(row.element) as Json & ManifestElement;
    const range = manifest.byte_range;
    if (range.chunk_id !== cachedChunkId) {
      const response = await call({
        operation: 'chunk',
        selection,
        sessionIndex,
        chunkId: range.chunk_id,
      });
      cachedChunk = decodeBase64(response.payload_base64);
      assert.equal(await sha256(cachedChunk), `sha256:${range.chunk_id}`);
      cachedChunkId = range.chunk_id;
    }
    const element = parseStoredElement(cachedChunk, manifest);
    assert.equal(element.chain_sequence, count, 'Archive chain sequence is not contiguous');
    assert.equal(element.previous_chain_hash, previous);
    const expectedChain =
      element.kind === 'record'
        ? await recordChainHash(previous, element.chain_sequence, element)
        : await checkpointChainHash(previous, element.chain_sequence, element.checkpoint);
    assert.equal(element.chain_hash, expectedChain, 'Archive chain hash mismatch');
    previous = element.chain_hash;
    count += 1;
    if (element.kind === 'checkpoint') {
      const checkpoint = element.checkpoint;
      if (checkpoint.archive_format_version === 2) {
        const relativePath = safeRelativePath(manifest.relative_path);
        let raw = rawParts.get(checkpoint.source_transcript_part_id);
        if (!raw) {
          assert.ok(
            !legacyParts.has(checkpoint.source_transcript_part_id),
            'Archive part mixes legacy records and exact byte segments',
          );
          raw = {
            file: `parts/${await safePartName(checkpoint.source_transcript_part_id)}.bin`,
            verifier: new RawPartVerifier(),
            initialized: true,
            firstObservedAt: checkpoint.first_observed_at,
            checkpointSequence: -1,
            ...(relativePath === undefined ? {} : { relativePath }),
          };
          rawParts.set(checkpoint.source_transcript_part_id, raw);
          await mkdir(dirname(resolve(sessionDirectory, raw.file)), { recursive: true });
          await writeFile(resolve(sessionDirectory, raw.file), new Uint8Array());
        }
        assert.equal(raw.relativePath, relativePath);
        raw.firstObservedAt = checkpoint.first_observed_at;
        raw.checkpointSequence = manifest.chain_sequence;
        raw.verifier.verifyCheckpoint(checkpoint);
      }
      continue;
    }
    recordCount += 1;
    const bytes = payloadBytes(element);
    assert.equal(await sha256(bytes), element.content_sha256, 'Record content hash mismatch');
    const hasRawOffsets =
      manifest.element_type === 'record' &&
      Number.isSafeInteger((manifest as Json).source_byte_start) &&
      Number.isSafeInteger((manifest as Json).source_byte_end);
    if (element.archive_format_version === 2) {
      assert.ok(hasRawOffsets, 'Format 2 record lacks authenticated byte offsets');
      assert.ok(
        !legacyParts.has(element.source_transcript_part_id),
        'Archive part mixes legacy records and exact byte segments',
      );
      const start = (manifest as Json).source_byte_start as number;
      const end = (manifest as Json).source_byte_end as number;
      const relativePath = safeRelativePath(manifest.relative_path);
      let raw = rawParts.get(element.source_transcript_part_id);
      if (!raw) {
        raw = {
          file: `parts/${await safePartName(element.source_transcript_part_id)}.bin`,
          verifier: new RawPartVerifier(),
          initialized: false,
          firstObservedAt: element.observed_at,
          checkpointSequence: -1,
          ...(relativePath === undefined ? {} : { relativePath }),
        };
        rawParts.set(element.source_transcript_part_id, raw);
      }
      assert.equal(raw.relativePath, relativePath);
      raw.verifier.addSegment({
        identity: element.source_record_identity,
        manifestStart: start,
        manifestEnd: end,
        manifestPredecessorPartId: (manifest as Json).predecessor_part_id as string | undefined,
        bytes,
      });
      const path = resolve(sessionDirectory, raw.file);
      await mkdir(dirname(path), { recursive: true });
      if (!raw.initialized) {
        await writeFile(path, bytes);
        raw.initialized = true;
      } else {
        await appendFile(path, bytes);
      }
    } else {
      assert.equal(hasRawOffsets, false, 'Legacy record has format 2 byte offsets');
      assert.ok(
        !rawParts.has(element.source_transcript_part_id),
        'Archive part mixes legacy records and exact byte segments',
      );
      let legacy = legacyParts.get(element.source_transcript_part_id);
      if (!legacy) {
        legacy = {
          file: `parts/${await safePartName(element.source_transcript_part_id)}.jsonl`,
          hash: createHash('sha256'),
          byteLength: 0,
          initialized: false,
        };
        legacyParts.set(element.source_transcript_part_id, legacy);
      }
      const line = Buffer.concat([Buffer.from(bytes), Buffer.from('\n')]);
      const path = resolve(sessionDirectory, legacy.file);
      if (!legacy.initialized) {
        await writeFile(path, line);
        legacy.initialized = true;
      } else {
        await appendFile(path, line);
      }
      legacy.hash.update(line);
      legacy.byteLength += line.byteLength;
    }
  }
  assert.equal(count, session.elementCount, 'Manifest element count mismatch');
  assert.equal(recordCount, session.recordCount, 'Manifest record count mismatch');
  assert.equal(previous, session.chainHead, 'Manifest chain head mismatch');

  for (const [partId, raw] of rawParts) {
    raw.verifier.assertComplete();
    parts.push({
      source_transcript_part_id: partId,
      file: raw.file,
      byte_exact: true,
      source_byte_start: 0,
      source_byte_end: raw.verifier.byteLength,
      ...(raw.verifier.predecessorPartId === undefined
        ? {}
        : { predecessor_part_id: raw.verifier.predecessorPartId }),
      sha256: raw.verifier.sha256(),
      byte_length: raw.verifier.byteLength,
      segment_count: raw.verifier.segmentCount,
      observed_source_size: raw.verifier.observedSourceSize,
      source_capture_complete: raw.verifier.sourceCaptureComplete,
      ...(raw.relativePath === undefined ? {} : { relative_path: raw.relativePath }),
    });
  }

  for (const sidecar of latestSidecarGenerations(
    [...rawParts.values()].flatMap((raw) =>
      raw.relativePath === undefined
        ? []
        : [
            {
              relativePath: raw.relativePath,
              file: raw.file,
              firstObservedAt: raw.firstObservedAt,
              checkpointSequence: raw.checkpointSequence,
            },
          ],
    ),
  )) {
    const destination = resolve(sessionDirectory, sidecar.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(sessionDirectory, sidecar.file), destination);
  }

  for (const [partId, legacy] of legacyParts) {
    parts.push({
      source_transcript_part_id: partId,
      file: legacy.file,
      byte_exact: false,
      sha256: `sha256:${legacy.hash.digest('hex')}`,
      byte_length: legacy.byteLength,
    });
  }
  await atomicWrite(
    resolve(sessionDirectory, 'manifest.json'),
    `${JSON.stringify({ ...session, parts }, null, 2)}\n`,
  );
}

await mkdir(outputDirectory, { recursive: true });
const priorManifest = await existingManifest();
function exportScope(): unknown {
  try {
    const payload = grant.split('.')[1];
    return payload
      ? (
          JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
            exportScope?: unknown;
          }
        ).exportScope
      : undefined;
  } catch {
    return undefined;
  }
}
let localManifest: LocalManifest;
if (priorManifest) {
  for (const batch of priorManifest.batches) {
    const selected = await call({ operation: 'select', selection: batch.selection });
    assert.deepEqual(selected.selection, batch.selection, 'Export batch changed on resume');
  }
  localManifest = priorManifest;
} else {
  const organization = exportScope() === 'organization';
  const catalog = organization ? await listSessions() : [];
  const batches: LocalManifest['batches'] = [];
  if (organization) {
    for (
      let sessionStart = 0;
      sessionStart < catalog.length;
      sessionStart += MAX_ARCHIVE_EXPORT_ORGANIZATION_BATCH_SESSIONS
    ) {
      const selected = await call({
        operation: 'select',
        sessions: catalog.slice(
          sessionStart,
          sessionStart + MAX_ARCHIVE_EXPORT_ORGANIZATION_BATCH_SESSIONS,
        ),
      });
      batches.push({ sessionStart, selection: selected.selection as Selection });
    }
    if (batches.length === 0) {
      const selected = await call({ operation: 'select', sessions: [] });
      batches.push({ sessionStart: 0, selection: selected.selection as Selection });
    }
  } else {
    const selected = await call({ operation: 'select' });
    batches.push({ sessionStart: 0, selection: selected.selection as Selection });
  }
  const first = batches[0]!.selection;
  const sessions = batches.flatMap((batch) => batch.selection.sessions);
  localManifest = {
    selection: organization
      ? { version: 1, exportId: first.exportId, orgId: first.orgId, sessions }
      : first,
    batches,
    sessions: sessions.map((_, session_index) => ({ session_index, status: 'pending' })),
  };
  await validateManifest(localManifest);
}
await atomicWrite(selectionPath, `${JSON.stringify(localManifest, null, 2)}\n`);
const database = openProgress();
let complete = false;
try {
  for (let index = 0; index < localManifest.selection.sessions.length; index++) {
    try {
      await collectManifestElements(database, localManifest, index);
      await writeSession(database, localManifest, index);
      localManifest.sessions[index] = { session_index: index, status: 'verified' };
    } catch (error) {
      localManifest.sessions[index] = { session_index: index, status: 'failed' };
      await atomicWrite(selectionPath, `${JSON.stringify(localManifest, null, 2)}\n`);
      throw error;
    }
    await atomicWrite(selectionPath, `${JSON.stringify(localManifest, null, 2)}\n`);
  }
  complete = true;
} finally {
  database.close();
}
if (complete) {
  await rm(progressPath, { force: true });
  await rm(`${progressPath}-wal`, { force: true });
  await rm(`${progressPath}-shm`, { force: true });
}
process.stdout.write(`${outputDirectory}\n`);
