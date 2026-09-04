import { encryptArchiveObject } from '@trace-flow/utils';
import {
  ArchiveContractError,
  MAX_CHUNK_BYTES,
  type ArchiveScope,
  type ArchiveSessionManifest,
  type ChunkByteRange,
  type LedgerElement,
  type StoredElement,
} from './archive-contract';
import { canonicalElement } from './archive-chain';
import { LEDGER_PAGE_SIZE, readInitialLedgerElementPageWithRanges } from './archive-ledger-index';
import {
  buildArchiveSessionManifest,
  buildIncrementalManifest,
  encryptManifestObject,
  type PlannedManifestObject,
} from './archive-manifest-packing';
import { archiveObjectKey } from './archive-storage-key';

export { archiveSessionPrefix } from './archive-storage-key';
export { buildArchiveSessionManifest } from './archive-manifest-packing';
export { buildIncrementalManifest } from './archive-manifest-packing';
export type { PlannedManifestObject } from './archive-manifest-packing';

export interface PackedChunk {
  chunkId: string;
  objectKey: string;
  plainBytes: Uint8Array;
  encryptedBody: string;
  ranges: Map<number, ChunkByteRange>;
}

export interface ArchiveObjectPlan {
  chunks: PackedChunk[];
  manifest: ArchiveSessionManifest;
  manifestKey: string;
  manifestBody: string;
  manifestPlaintextBody: string;
  manifestObjects: PlannedManifestObject[];
  manifestHeadPageKey: string;
}

function digestString(bytes: Uint8Array): string {
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return digestString(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function elementBytes(element: StoredElement): Uint8Array {
  return new TextEncoder().encode(`${canonicalElement(element)}\n`);
}

async function packChunks(
  scope: ArchiveScope,
  newElements: StoredElement[],
  key: CryptoKey,
  keyVersion: number,
  onChunk?: (chunk: PackedChunk) => Promise<void>,
): Promise<{ chunks: PackedChunk[]; ranges: Map<number, ChunkByteRange> }> {
  const chunks: PackedChunk[] = [];
  const ranges = new Map<number, ChunkByteRange>();
  let current: StoredElement[] = [];
  let currentSize = 0;

  const flush = async (): Promise<void> => {
    if (current.length === 0) return;
    const plainBytes = new TextEncoder().encode(
      current.map((element) => `${canonicalElement(element)}\n`).join(''),
    );
    if (plainBytes.byteLength > MAX_CHUNK_BYTES) {
      throw new ArchiveContractError('archive_element_exceeds_chunk_limit');
    }
    const digest = await sha256(plainBytes);
    const chunkObjectKey = await archiveObjectKey(scope, 'chunks', digest);
    const compressedBytes = await compress(plainBytes);
    const encrypted = await encryptArchiveObject(compressedBytes, {
      key,
      orgId: scope.orgId,
      objectKey: chunkObjectKey,
      objectClass: 'chunk',
      keyVersion,
    });
    const chunkRanges = new Map<number, ChunkByteRange>();
    let offset = 0;
    for (const element of current) {
      const size = elementBytes(element).byteLength;
      const range = { chunk_id: digest.slice(7), start: offset, end: offset + size };
      if (range.end > MAX_CHUNK_BYTES) throw new Error('archive_chunk_range_exceeds_limit');
      chunkRanges.set(element.chain_sequence, range);
      ranges.set(element.chain_sequence, range);
      offset += size;
    }
    const chunk = {
      chunkId: digest.slice(7),
      objectKey: chunkObjectKey,
      plainBytes,
      encryptedBody: JSON.stringify(encrypted),
      ranges: chunkRanges,
    };
    chunks.push(chunk);
    if (onChunk) await onChunk(chunk);
    current = [];
    currentSize = 0;
  };

  for (const element of newElements) {
    const size = elementBytes(element).byteLength;
    if (size > MAX_CHUNK_BYTES) {
      throw new ArchiveContractError('archive_element_exceeds_chunk_limit');
    }
    if (currentSize > 0 && currentSize + size > MAX_CHUNK_BYTES) await flush();
    current.push(element);
    currentSize += size;
  }
  await flush();
  return { chunks, ranges };
}

export async function packNewElementsPaged(
  scope: ArchiveScope,
  storage: DurableObjectStorage,
  existingElementCount: number,
  newElements: StoredElement[],
  generation: number,
  chainHead: string,
  key: CryptoKey,
  keyVersion: number,
  onChunk?: (chunk: PackedChunk) => Promise<void>,
  previousManifestHeadPageKey?: string,
): Promise<ArchiveObjectPlan> {
  const packed = await packChunks(scope, newElements, key, keyVersion, onChunk);
  if (
    !previousManifestHeadPageKey &&
    existingElementCount === 0 &&
    newElements.length <= LEDGER_PAGE_SIZE
  ) {
    const allElements: LedgerElement[] = [];
    const ranges: Record<string, ChunkByteRange> = {};
    const rows = readInitialLedgerElementPageWithRanges(storage);
    for (const row of rows) {
      allElements.push(row.element);
      ranges[String(row.element.chain_sequence)] = row.range;
    }
    for (const element of newElements) {
      const range = packed.ranges.get(element.chain_sequence);
      if (!range) throw new Error('archive_manifest_range_missing');
      allElements.push(element);
      ranges[String(element.chain_sequence)] = range;
    }
    const directManifest = buildArchiveSessionManifest(scope, allElements, ranges, generation);
    const root = await encryptManifestObject(
      scope,
      JSON.stringify(directManifest),
      key,
      keyVersion,
    );
    return {
      chunks: packed.chunks,
      manifest: directManifest,
      manifestKey: root.key,
      manifestBody: root.body,
      manifestPlaintextBody: JSON.stringify(directManifest),
      manifestObjects: [root],
      manifestHeadPageKey: root.key,
    };
  }
  const manifest = await buildIncrementalManifest(
    scope,
    existingElementCount,
    newElements,
    packed.ranges,
    generation,
    chainHead,
    key,
    keyVersion,
    previousManifestHeadPageKey,
  );
  const root = manifest.objects.at(-1)!;
  return {
    chunks: packed.chunks,
    manifest: manifest.manifest,
    manifestKey: root.key,
    manifestBody: root.body,
    manifestPlaintextBody: JSON.stringify(manifest.manifest),
    manifestObjects: manifest.objects,
    manifestHeadPageKey: manifest.manifestHeadPageKey,
  };
}

export async function packNewElements(
  scope: ArchiveScope,
  allElements: LedgerElement[],
  newElements: StoredElement[],
  existingRanges: Record<string, ChunkByteRange>,
  generation: number,
  key: CryptoKey,
  keyVersion: number,
  onChunk?: (chunk: PackedChunk) => Promise<void>,
): Promise<ArchiveObjectPlan> {
  const packed = await packChunks(scope, newElements, key, keyVersion, onChunk);
  const ranges: Record<string, ChunkByteRange> = { ...existingRanges };
  for (const [sequence, range] of packed.ranges) ranges[String(sequence)] = range;
  const manifest = buildArchiveSessionManifest(scope, allElements, ranges, generation);
  const root = await encryptManifestObject(scope, JSON.stringify(manifest), key, keyVersion);
  return {
    chunks: packed.chunks,
    manifest,
    manifestKey: root.key,
    manifestBody: root.body,
    manifestPlaintextBody: JSON.stringify(manifest),
    manifestObjects: [root],
    manifestHeadPageKey: root.key,
  };
}
