import { encryptArchiveObject } from '@trace-flow/utils';
import {
  ArchiveContractError,
  MAX_MANIFEST_BYTES,
  type ArchiveScope,
  type ArchiveSessionManifest,
  type ArchiveSessionManifestPage,
  type ChunkByteRange,
  type LedgerElement,
  type ManifestElement,
  type ManifestPageReference,
} from './archive-contract';
import { LEDGER_PAGE_SIZE } from './archive-ledger-index';
import { archiveObjectKey } from './archive-storage-key';

export interface PlannedManifestObject {
  key: string;
  body: string;
  objectClass: 'manifest';
  plaintext: Uint8Array;
}

function manifestElement(element: LedgerElement, range: ChunkByteRange): ManifestElement {
  if (element.kind === 'record') {
    return {
      element_type: 'record',
      chain_sequence: element.chain_sequence,
      source_transcript_part_id: element.source_transcript_part_id,
      source_record_identity: element.source_record_identity,
      content_sha256: element.content_sha256,
      chain_hash: element.chain_hash,
      byte_range: range,
    };
  }
  return {
    element_type: 'checkpoint',
    chain_sequence: element.chain_sequence,
    checkpoint: element.checkpoint,
    chain_hash: element.chain_hash,
    byte_range: range,
  };
}

export async function encryptManifestObject(
  scope: ArchiveScope,
  plaintextBody: string,
  key: CryptoKey,
  keyVersion: number,
): Promise<PlannedManifestObject> {
  const plaintext = new TextEncoder().encode(plaintextBody);
  if (plaintext.byteLength > MAX_MANIFEST_BYTES) {
    throw new ArchiveContractError('archive_manifest_page_too_large');
  }
  const digest = `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
  const keyName = await archiveObjectKey(scope, 'manifests', digest);
  const encrypted = await encryptArchiveObject(plaintext, {
    key,
    orgId: scope.orgId,
    objectKey: keyName,
    objectClass: 'manifest',
    keyVersion,
  });
  return { key: keyName, body: JSON.stringify(encrypted), objectClass: 'manifest', plaintext };
}

function pageBody(
  scope: ArchiveScope,
  generation: number,
  elementStart: number,
  elements: ManifestElement[],
): string {
  const page: ArchiveSessionManifestPage = {
    archive_format_version: 1,
    chain_hash_version: 1,
    source: scope.source,
    source_session_id: scope.sourceSessionId,
    generation,
    element_start: elementStart,
    element_count: elements.length,
    elements,
  };
  return JSON.stringify(page);
}

function indexBody(
  scope: ArchiveScope,
  generation: number,
  elementStart: number,
  elementCount: number,
  pages: ManifestPageReference[],
  previousPageKey: string | undefined,
): string {
  const page: ArchiveSessionManifestPage = {
    archive_format_version: 1,
    chain_hash_version: 1,
    source: scope.source,
    source_session_id: scope.sourceSessionId,
    generation,
    element_start: elementStart,
    element_count: elementCount,
    previous_page_key: previousPageKey,
    pages,
  };
  return JSON.stringify(page);
}

function refsToBatches(refs: ManifestPageReference[]): ManifestPageReference[][] {
  const batches: ManifestPageReference[][] = [];
  for (let offset = 0; offset < refs.length; offset += 128) {
    batches.push(refs.slice(offset, offset + 128));
  }
  return batches;
}

export async function buildIncrementalManifest(
  scope: ArchiveScope,
  existingElementCount: number,
  newElements: LedgerElement[],
  newRanges: Map<number, ChunkByteRange>,
  generation: number,
  chainHead: string,
  key: CryptoKey,
  keyVersion: number,
  previousPageKey?: string,
): Promise<{
  manifest: ArchiveSessionManifest;
  objects: PlannedManifestObject[];
  manifestHeadPageKey: string;
}> {
  const objects: PlannedManifestObject[] = [];
  const leafRefs: ManifestPageReference[] = [];
  let pageElements: ManifestElement[] = [];
  let pageStart = existingElementCount;

  const flushLeaf = async (): Promise<void> => {
    if (pageElements.length === 0) return;
    const object = await encryptManifestObject(
      scope,
      pageBody(scope, generation, pageStart, pageElements),
      key,
      keyVersion,
    );
    objects.push(object);
    leafRefs.push({
      page_key: object.key,
      element_start: pageStart,
      element_count: pageElements.length,
    });
    pageStart += pageElements.length;
    pageElements = [];
  };

  const add = async (element: LedgerElement, range: ChunkByteRange): Promise<void> => {
    pageElements.push(manifestElement(element, range));
    if (pageElements.length >= LEDGER_PAGE_SIZE) await flushLeaf();
  };

  for (const element of newElements) {
    const range = newRanges.get(element.chain_sequence);
    if (!range) throw new Error('archive_manifest_range_missing');
    await add(element, range);
  }
  await flushLeaf();
  if (leafRefs.length === 0 || newElements.length === 0) {
    throw new Error('archive_manifest_empty');
  }

  if (!previousPageKey && existingElementCount === 0 && newElements.length <= LEDGER_PAGE_SIZE) {
    const elements = newElements.map((element) => {
      const range = newRanges.get(element.chain_sequence);
      if (!range) throw new Error('archive_manifest_range_missing');
      return manifestElement(element, range);
    });
    const manifest: ArchiveSessionManifest = {
      archive_format_version: 1,
      chain_hash_version: 1,
      source: scope.source,
      source_session_id: scope.sourceSessionId,
      generation,
      element_count: elements.length,
      chain_head: chainHead,
      elements,
    };
    const root = await encryptManifestObject(scope, JSON.stringify(manifest), key, keyVersion);
    return { manifest, objects: [root], manifestHeadPageKey: root.key };
  }

  let previous = previousPageKey;
  let levelRefs = leafRefs;
  while (levelRefs.length > 128) {
    const nextRefs: ManifestPageReference[] = [];
    for (const batch of refsToBatches(levelRefs)) {
      const first = batch[0]!;
      const batchCount = batch.reduce((sum, ref) => sum + ref.element_count, 0);
      const object = await encryptManifestObject(
        scope,
        indexBody(scope, generation, first.element_start, batchCount, batch, undefined),
        key,
        keyVersion,
      );
      objects.push(object);
      nextRefs.push({
        page_key: object.key,
        element_start: first.element_start,
        element_count: batchCount,
      });
    }
    levelRefs = nextRefs;
  }

  const headRefs = refsToBatches(levelRefs);
  if (headRefs.length !== 1) throw new Error('archive_manifest_fanout_exceeded');
  const headBatch = headRefs[0]!;
  const headCount = headBatch.reduce((sum, ref) => sum + ref.element_count, 0);
  const head = await encryptManifestObject(
    scope,
    indexBody(scope, generation, headBatch[0]!.element_start, headCount, headBatch, previous),
    key,
    keyVersion,
  );
  objects.push(head);
  previous = head.key;

  const headPageKey = previous;
  if (!headPageKey) throw new Error('archive_manifest_head_missing');

  const manifest: ArchiveSessionManifest = {
    archive_format_version: 1,
    chain_hash_version: 1,
    source: scope.source,
    source_session_id: scope.sourceSessionId,
    generation,
    element_count: existingElementCount + newElements.length,
    chain_head: chainHead,
    pages: [
      {
        page_key: headPageKey,
        element_start: 0,
        element_count: existingElementCount + newElements.length,
      },
    ],
  };
  const root = await encryptManifestObject(scope, JSON.stringify(manifest), key, keyVersion);
  objects.push(root);
  return { manifest, objects, manifestHeadPageKey: headPageKey };
}

export function buildArchiveSessionManifest(
  scope: ArchiveScope,
  allElements: LedgerElement[],
  ranges: Record<string, ChunkByteRange>,
  generation: number,
): ArchiveSessionManifest {
  const elements = allElements.map((element) => {
    const range = ranges[String(element.chain_sequence)];
    if (!range) throw new Error('archive_manifest_range_missing');
    return manifestElement(element, range);
  });
  return {
    archive_format_version: 1,
    chain_hash_version: 1,
    source: scope.source,
    source_session_id: scope.sourceSessionId,
    generation,
    element_count: allElements.length,
    chain_head: allElements.at(-1)?.chain_hash ?? `sha256:${'00'.repeat(32)}`,
    elements,
  };
}
