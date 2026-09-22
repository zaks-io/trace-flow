import type { Logger } from '@trace-flow/logging';
import {
  decryptArchiveObject,
  parseArchiveWrappedKeyVersion,
  unwrapArchiveEncryptionKey,
  type ArchiveObjectEnvelope,
} from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import {
  ArchiveContractError,
  MAX_CHUNK_BYTES,
  MAX_MANIFEST_BYTES,
  digestString,
  type ArchiveScope,
} from './archive-contract';
import { getArchiveWrappedKeyVersion } from './archive-key-client';
import { MAX_ENCRYPTED_ARCHIVE_OBJECT_BYTES } from './archive-key-reencryption';
import { archiveObjectKey, archiveSessionPrefix } from './archive-storage-key';
import type { ArchiveExportGrant, ArchiveExportTarget } from './export-grant';
import type { LedgerSnapshot } from './archive-ledger-state';
import type { ArchiveSessionCatalogEntry } from './archive-session-catalog';
import { isArchiveCanonicalIdentifier } from '@trace-flow/types';

export const MAX_ARCHIVE_EXPORT_REQUEST_BYTES = 512 * 1024;
export const MAX_ARCHIVE_EXPORT_ORGANIZATION_BATCH_SESSIONS = 64;

export interface ArchiveExportSessionSelection extends ArchiveExportTarget {
  manifestKey: string;
  manifestHeadPageKey: string;
  generation: number;
  elementCount: number;
  recordCount: number;
  chainHead: string;
}

export interface ArchiveExportSelection {
  version: 1;
  exportId: string;
  orgId: string;
  sessions: ArchiveExportSessionSelection[];
  selectionSha256: string;
  selectionToken: string;
}

type UnsignedArchiveExportSelection = Omit<
  ArchiveExportSelection,
  'selectionSha256' | 'selectionToken'
>;

type ExportRequest =
  | {
      operation: 'select';
      selection?: ArchiveExportSelection;
      sessions?: ArchiveSessionCatalogEntry[];
    }
  | {
      operation: 'manifest';
      selection: ArchiveExportSelection;
      sessionIndex: number;
      objectKey: string;
    }
  | {
      operation: 'chunk';
      selection: ArchiveExportSelection;
      sessionIndex: number;
      chunkId: string;
    };

function canonicalSelection(selection: UnsignedArchiveExportSelection): string {
  return JSON.stringify(selection);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return digestString(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function selectionDigest(selection: UnsignedArchiveExportSelection): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalSelection(selection)));
}

async function selectionToken(secret: string, digest: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`trace-flow/archive/export-selection/v1\0${digest}`),
    ),
  );
  return btoa(String.fromCharCode(...signature))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

function scopeFor(orgId: string, target: ArchiveExportTarget): ArchiveScope {
  return {
    orgId,
    userId: target.userId,
    contributionId: target.contributionId,
    source: target.source,
    sourceSessionId: target.sourceSessionId,
  };
}

function ledger(env: ArchiveApiEnv, scope: ArchiveScope) {
  const id = env.ARCHIVE_SESSION_LEDGER.idFromName(
    JSON.stringify([scope.orgId, scope.contributionId, scope.source, scope.sourceSessionId]),
  );
  return env.ARCHIVE_SESSION_LEDGER.get(id) as unknown as {
    exportSnapshot(input: { scope: ArchiveScope }): Promise<LedgerSnapshot | null>;
  };
}

function requiredSnapshot(snapshot: LedgerSnapshot | null): asserts snapshot is LedgerSnapshot & {
  scope: ArchiveScope;
  keyVersion: number;
  manifestKey: string;
} {
  if (!snapshot?.scope || !snapshot.keyVersion || !snapshot.manifestKey) {
    throw new ArchiveContractError('archive_export_session_empty');
  }
}

async function pinSelection(
  env: ArchiveApiEnv,
  grant: ArchiveExportGrant,
): Promise<ArchiveExportSelection> {
  const sessions: ArchiveExportSessionSelection[] = [];
  for (const target of grant.targets ?? []) {
    const scope = scopeFor(grant.orgId, target);
    const snapshot = await ledger(env, scope).exportSnapshot({ scope });
    requiredSnapshot(snapshot);
    sessions.push({
      ...target,
      manifestKey: snapshot.manifestKey,
      manifestHeadPageKey: snapshot.manifestHeadPageKey ?? snapshot.manifestKey,
      generation: snapshot.generation,
      elementCount: snapshot.elementCount,
      recordCount: snapshot.recordCount,
      chainHead: snapshot.chainHead,
    });
  }
  const unsigned = {
    version: 1 as const,
    exportId: grant.exportId,
    orgId: grant.orgId,
    sessions,
  };
  const selectionSha256 = await selectionDigest(unsigned);
  return {
    ...unsigned,
    selectionSha256,
    selectionToken: await selectionToken(env.ARCHIVE_API_SHARED_SECRET, selectionSha256),
  };
}

async function pinOrganizationSelection(
  env: ArchiveApiEnv,
  grant: ArchiveExportGrant,
  requested: ArchiveSessionCatalogEntry[] | undefined,
): Promise<ArchiveExportSelection> {
  if (requested === undefined) throw new ArchiveContractError('archive_export_catalog_required');
  if (
    !Array.isArray(requested) ||
    requested.length > MAX_ARCHIVE_EXPORT_ORGANIZATION_BATCH_SESSIONS
  ) {
    throw new ArchiveContractError('archive_export_catalog_invalid');
  }
  const ledgerIds = new Set<string>();
  for (const session of requested) {
    if (
      typeof session !== 'object' ||
      session === null ||
      !/^[a-f0-9]{64}$/u.test(session.ledgerId) ||
      ledgerIds.has(session.ledgerId) ||
      !isArchiveCanonicalIdentifier(session.userId) ||
      !isArchiveCanonicalIdentifier(session.contributionId) ||
      (session.source !== 'claude' && session.source !== 'codex') ||
      !isArchiveCanonicalIdentifier(session.sourceSessionId) ||
      typeof session.manifestKey !== 'string' ||
      typeof session.manifestHeadPageKey !== 'string' ||
      !Number.isSafeInteger(session.generation) ||
      session.generation < 1 ||
      !Number.isSafeInteger(session.elementCount) ||
      session.elementCount < 1 ||
      !Number.isSafeInteger(session.recordCount) ||
      session.recordCount < 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(session.chainHead)
    ) {
      throw new ArchiveContractError('archive_export_catalog_invalid');
    }
    ledgerIds.add(session.ledgerId);
  }
  const unsigned = {
    version: 1 as const,
    exportId: grant.exportId,
    orgId: grant.orgId,
    sessions: requested.map(({ ledgerId: _ledgerId, ...session }) => session),
  };
  const selectionSha256 = await selectionDigest(unsigned);
  return {
    ...unsigned,
    selectionSha256,
    selectionToken: await selectionToken(env.ARCHIVE_API_SHARED_SECRET, selectionSha256),
  };
}

async function validateSelection(
  value: ArchiveExportSelection,
  grant: ArchiveExportGrant,
  sharedSecret: string,
): Promise<ArchiveExportSelection> {
  if (
    typeof value !== 'object' ||
    value?.version !== 1 ||
    value.exportId !== grant.exportId ||
    value.orgId !== grant.orgId ||
    !Array.isArray(value.sessions) ||
    (grant.exportScope === 'organization' &&
      value.sessions.length > MAX_ARCHIVE_EXPORT_ORGANIZATION_BATCH_SESSIONS) ||
    (grant.exportScope === 'targets' && value.sessions.length !== grant.targets?.length) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.selectionSha256) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.selectionToken)
  ) {
    throw new ArchiveContractError('archive_export_selection_invalid');
  }
  for (let index = 0; index < value.sessions.length; index++) {
    const target = grant.targets?.[index];
    const session = value.sessions[index];
    if (
      (target !== undefined &&
        (session?.userId !== target.userId ||
          session?.contributionId !== target.contributionId ||
          session?.source !== target.source ||
          session?.sourceSessionId !== target.sourceSessionId)) ||
      session?.userId === undefined ||
      typeof session.manifestKey !== 'string' ||
      typeof session.manifestHeadPageKey !== 'string' ||
      !Number.isSafeInteger(session.generation) ||
      session.generation < 1 ||
      !Number.isSafeInteger(session.elementCount) ||
      session.elementCount < 1 ||
      !Number.isSafeInteger(session.recordCount) ||
      session.recordCount < 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(session.chainHead)
    ) {
      throw new ArchiveContractError('archive_export_selection_invalid');
    }
  }
  const { selectionSha256, selectionToken: suppliedToken, ...unsigned } = value;
  if ((await selectionDigest(unsigned)) !== selectionSha256) {
    throw new ArchiveContractError('archive_export_selection_invalid');
  }
  const expectedToken = await selectionToken(sharedSecret, selectionSha256);
  if (expectedToken !== suppliedToken) {
    throw new ArchiveContractError('archive_export_selection_invalid');
  }
  return value;
}

function parseRequest(value: unknown): ExportRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArchiveContractError('archive_export_request_invalid');
  }
  const body = value as Record<string, unknown>;
  if (body.operation === 'select') {
    return {
      operation: 'select',
      ...(body.sessions === undefined
        ? {}
        : { sessions: body.sessions as ArchiveSessionCatalogEntry[] }),
      ...(body.selection === undefined
        ? {}
        : { selection: body.selection as ArchiveExportSelection }),
    };
  }
  if (
    (body.operation === 'manifest' || body.operation === 'chunk') &&
    Number.isSafeInteger(body.sessionIndex) &&
    (body.sessionIndex as number) >= 0
  ) {
    if (body.operation === 'manifest' && typeof body.objectKey === 'string') {
      return {
        operation: 'manifest',
        selection: body.selection as ArchiveExportSelection,
        sessionIndex: body.sessionIndex as number,
        objectKey: body.objectKey,
      };
    }
    if (body.operation === 'chunk' && typeof body.chunkId === 'string') {
      return {
        operation: 'chunk',
        selection: body.selection as ArchiveExportSelection,
        sessionIndex: body.sessionIndex as number,
        chunkId: body.chunkId,
      };
    }
  }
  throw new ArchiveContractError('archive_export_request_invalid');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function boundedDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CHUNK_BYTES) {
        value.fill(0);
        throw new ArchiveContractError('archive_export_object_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
    if (error instanceof ArchiveContractError) throw error;
    throw new ArchiveContractError('archive_export_decompression_failed');
  }
  const plaintext = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    plaintext.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return plaintext;
}

async function decryptObject(
  env: ArchiveApiEnv,
  logger: Logger,
  scope: ArchiveScope,
  objectKey: string,
  objectClass: 'manifest' | 'chunk',
): Promise<Uint8Array> {
  const object = await env.ARCHIVE_STORAGE.get(objectKey);
  if (!object) throw new ArchiveContractError('archive_export_object_missing');
  if (object.size > MAX_ENCRYPTED_ARCHIVE_OBJECT_BYTES) {
    throw new ArchiveContractError('archive_export_object_too_large');
  }
  try {
    const envelope = JSON.parse(await object.text()) as ArchiveObjectEnvelope;
    if (!Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1) throw new Error();
    const wrapped = await getArchiveWrappedKeyVersion(
      env,
      { orgId: scope.orgId, keyVersion: envelope.keyVersion },
      logger,
    );
    const parsed = parseArchiveWrappedKeyVersion(wrapped.wrappedKey, {
      orgId: scope.orgId,
      keyVersion: envelope.keyVersion,
    });
    const key = await unwrapArchiveEncryptionKey(parsed, {
      orgId: scope.orgId,
      keyVersion: envelope.keyVersion,
      wrappingSecretBase64: env.ARCHIVE_KEY_WRAPPING_SECRET,
    });
    const plaintext = await decryptArchiveObject(envelope, {
      key,
      orgId: scope.orgId,
      objectKey,
      objectClass,
      keyVersion: envelope.keyVersion,
    });
    if (objectClass === 'manifest' && plaintext.byteLength > MAX_MANIFEST_BYTES) {
      plaintext.fill(0);
      throw new ArchiveContractError('archive_export_object_too_large');
    }
    return plaintext;
  } catch (error) {
    if (error instanceof ArchiveContractError) throw error;
    throw new ArchiveContractError('archive_export_decryption_failed');
  }
}

export async function executeArchiveExport(
  env: ArchiveApiEnv,
  grant: ArchiveExportGrant,
  rawRequest: unknown,
  logger: Logger,
): Promise<unknown> {
  const request = parseRequest(rawRequest);
  if (request.operation === 'select') {
    const selection = request.selection
      ? await validateSelection(request.selection, grant, env.ARCHIVE_API_SHARED_SECRET)
      : grant.exportScope === 'organization'
        ? await pinOrganizationSelection(env, grant, request.sessions)
        : await pinSelection(env, grant);
    return { operation: 'select', selection };
  }

  const selection = await validateSelection(
    request.selection,
    grant,
    env.ARCHIVE_API_SHARED_SECRET,
  );
  const session = selection.sessions[request.sessionIndex];
  if (!session) throw new ArchiveContractError('archive_export_session_invalid');
  const scope = scopeFor(grant.orgId, session);
  const prefix = await archiveSessionPrefix(scope);

  if (request.operation === 'manifest') {
    if (!request.objectKey.startsWith(`${prefix}/manifests/`)) {
      throw new ArchiveContractError('archive_export_object_invalid');
    }
    const plaintext = await decryptObject(env, logger, scope, request.objectKey, 'manifest');
    const digest = await sha256(plaintext);
    if ((await archiveObjectKey(scope, 'manifests', digest)) !== request.objectKey) {
      throw new ArchiveContractError('archive_export_hash_mismatch');
    }
    const manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext),
    ) as Record<string, unknown>;
    const isRoot = request.objectKey === session.manifestKey;
    if (
      manifest.source !== scope.source ||
      manifest.source_session_id !== scope.sourceSessionId ||
      !Number.isSafeInteger(manifest.generation) ||
      (manifest.generation as number) < 1 ||
      (manifest.generation as number) > session.generation
    ) {
      throw new ArchiveContractError('archive_export_manifest_mismatch');
    }
    if (manifest.archive_scope !== undefined) {
      const manifestScope = manifest.archive_scope as Record<string, unknown>;
      for (const field of [
        'orgId',
        'userId',
        'contributionId',
        'source',
        'sourceSessionId',
      ] as const) {
        if (manifestScope[field] !== scope[field]) {
          throw new ArchiveContractError('archive_export_manifest_mismatch');
        }
      }
    }
    if (
      isRoot &&
      (manifest.generation !== session.generation ||
        manifest.element_count !== session.elementCount ||
        manifest.chain_head !== session.chainHead)
    ) {
      throw new ArchiveContractError('archive_export_manifest_mismatch');
    }
    return { operation: 'manifest', object_key: request.objectKey, sha256: digest, manifest };
  }

  if (!/^[0-9a-f]{64}$/u.test(request.chunkId)) {
    throw new ArchiveContractError('archive_export_object_invalid');
  }
  const objectKey = await archiveObjectKey(scope, 'chunks', `sha256:${request.chunkId}`);
  const compressed = await decryptObject(env, logger, scope, objectKey, 'chunk');
  const plaintext = await boundedDecompress(compressed);
  const digest = await sha256(plaintext);
  if (digest !== `sha256:${request.chunkId}`) {
    throw new ArchiveContractError('archive_export_hash_mismatch');
  }
  return {
    operation: 'chunk',
    chunk_id: request.chunkId,
    sha256: digest,
    payload_base64: toBase64(plaintext),
  };
}
