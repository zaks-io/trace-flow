import {
  createExecutionContext,
  env as workerEnv,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { expect, vi } from 'vitest';
import {
  createArchiveEncryptionKeyVersion,
  decryptArchiveObject,
  serializeArchiveWrappedKeyVersion,
  sha256Hex,
  type ArchiveObjectEnvelope,
  unwrapArchiveEncryptionKey,
} from '@trace-flow/utils';
import {
  ARCHIVE_FORMAT_VERSION,
  CHAIN_HASH_VERSION,
  GENESIS_CHAIN_HASH,
  MAX_CHUNK_BYTES,
  MAX_UPLOAD_OBSERVATIONS,
  type ArchiveScope,
  type ArchiveSource,
  type ArchiveUploadRequest,
  type CompletedScanCheckpoint,
  type StoredElement,
  type StoredRecord,
} from '../archive-contract';
import { validateObservation } from '../archive-contract-validation';
import {
  buildRecord,
  canonicalElement,
  checkpointChainHash,
  recordChainHash,
} from '../archive-chain';
import { archiveSessionPrefix, packNewElements, decompress } from '../archive-packing';
import { storageBudgetObject } from '../archive-r2';
import type { ArchiveSessionLedger } from '../archive-ledger';
import type { StorageBudget } from '../archive-storage-budget';
import { app } from '../index';
import type { ArchiveApiEnv } from '../context';
import { payloadBytes } from '../archive-contract';
import { parseAndValidateUpload, sourceFingerprints } from '../archive-validation';
import { prefixChainHash } from '../archive-prefix-validation';
import { MAX_ARCHIVE_UPLOAD_BYTES } from '../archive-request';
import { buildAcknowledgement, intentDigest } from '../archive-ledger-support';
import { commitArchiveSession } from '../archive-ledger-commit';
import { ARCHIVE_STORAGE_CAP_BYTES } from '../archive-storage-budget';
import type { ArchiveAcknowledgement, LedgerCommit, LedgerSnapshot } from '../archive-ledger-state';
import { readLedgerScan, readLedgerSnapshot } from '../archive-ledger-storage';
import {
  encodePendingPlaintext,
  encryptPendingIntentState,
  discardPendingIntent,
  markIntentReady,
  markIntentWriteAuthorized,
  pendingIntentStateHash,
  readPendingIntent,
  writeIntent,
  type PendingIntent,
} from '../archive-ledger-intent';
import claudeFixture from '../../../../packages/collector-archive/tests/fixtures/claude.jsonl?raw';
import codexFixture from '../../../../packages/collector-archive/tests/fixtures/codex.jsonl?raw';
import rustWireSessionJson from '../../../../packages/collector-archive/tests/fixtures/archive-wire-session.json?raw';
import { app as agentIngestApp } from '../../../agent-ingest/src/index';
import { __resetPolicyCache } from '../../../agent-ingest/src/policy';
import type { AgentIngestEnv } from '../../../agent-ingest/src/context';
import { envelope as agentIngestEnvelope } from '../../../agent-ingest/src/__tests__/factories';

export const WRAPPING_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
export const KEY_VERSION = 1;
export const runtimeEnv = workerEnv as unknown as {
  COLLECTOR_CREDS: KVNamespace;
  ARCHIVE_SESSION_LEDGER: DurableObjectNamespace<ArchiveSessionLedger>;
  STORAGE_BUDGET: DurableObjectNamespace<StorageBudget>;
  ARCHIVE_STORAGE: R2Bucket;
  ARCHIVE_KEY_VERSION: string;
  ARCHIVE_KEY_WRAPPING_SECRET: string;
};
const wrappedKeys = new Map<string, string>();

export async function archiveKeyHttpResponse(
  pathname: string,
  onVersionedKey: () => Response | Promise<Response> = async () => {
    throw new Error('archive key version endpoint must not be reached');
  },
): Promise<Response | null> {
  if (pathname === '/archive-api/key/active') {
    return new Response(JSON.stringify({ error: 'Archive key unavailable' }), { status: 404 });
  }
  if (pathname === '/archive-api/key') {
    return await onVersionedKey();
  }
  return null;
}

export async function fallbackArchiveKeyHttp(
  pathname: string,
  orgId: string,
): Promise<Response | null> {
  return archiveKeyHttpResponse(pathname, async () =>
    Response.json({
      wrappedKey: await archiveKey(orgId),
      keyVersion: KEY_VERSION,
    }),
  );
}

export function partFor(source: ArchiveSource): string {
  return source === 'claude' ? 'claude:part:parent' : 'codex:part:primary';
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const end = Math.min(offset + 0x8000, bytes.length);
    const chars = new Array<string>(end - offset);
    for (let index = offset; index < end; index++) {
      chars[index - offset] = String.fromCharCode(bytes[index]!);
    }
    binary += chars.join('');
  }
  return btoa(binary);
}

export function exactPrefix(observations: ArchiveUploadRequest['observations']): Uint8Array {
  const lines = observations.map((item) => {
    const payload = payloadBytes(item);
    const line = new Uint8Array(payload.length + 1);
    line.set(payload);
    line[payload.length] = 0x0a;
    return line;
  });
  const prefix = new Uint8Array(lines.reduce((sum, line) => sum + line.length, 0));
  let offset = 0;
  for (const line of lines) {
    prefix.set(line, offset);
    offset += line.length;
  }
  return prefix;
}

export async function digest(bytes: Uint8Array): Promise<string> {
  return `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export async function observation(
  source: ArchiveSource,
  session: string,
  part: string,
  identity: string,
  payload: string,
  observedAt = 1_700_000_000_000,
) {
  const bytes = new TextEncoder().encode(payload);
  return {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
    chain_hash_version: CHAIN_HASH_VERSION,
    source,
    source_session_id: session,
    source_transcript_part_id: part,
    source_record_identity: identity,
    observed_at: observedAt,
    payload_encoding: 'utf8' as const,
    payload,
    content_sha256: await digest(bytes),
  };
}

export async function checkpoint(
  source: ArchiveSource,
  session: string,
  part: string,
  observations: ArchiveUploadRequest['observations'],
  observedFileSize?: number,
  firstObservedAt = 1_700_000_000_000,
): Promise<CompletedScanCheckpoint> {
  const lines = observations.map((item) => new TextEncoder().encode(`${item.payload}\n`));
  const prefix = new Uint8Array(lines.reduce((sum, line) => sum + line.length, 0));
  let offset = 0;
  for (const line of lines) {
    prefix.set(line, offset);
    offset += line.length;
  }
  return {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
    chain_hash_version: CHAIN_HASH_VERSION,
    source,
    source_session_id: session,
    source_transcript_part_id: part,
    record_count: observations.length,
    last_source_record_identity: observations.at(-1)?.source_record_identity ?? null,
    last_complete_byte_offset: prefix.length,
    observed_file_size: observedFileSize ?? prefix.length,
    complete_prefix_sha256: await digest(prefix),
    prefix_chain_sha256: await prefixChainHash(undefined, prefix),
    first_observed_at: firstObservedAt,
  };
}

export async function archiveKey(orgId: string) {
  const existing = wrappedKeys.get(orgId);
  if (existing) return existing;
  const wrapped = await createArchiveEncryptionKeyVersion({
    orgId,
    keyVersion: KEY_VERSION,
    wrappingSecretBase64: WRAPPING_SECRET,
  });
  const serialized = serializeArchiveWrappedKeyVersion(wrapped);
  wrappedKeys.set(orgId, serialized);
  return serialized;
}

export async function fixtureUpload(
  source: ArchiveSource,
  session: string,
  fixture: string,
): Promise<ArchiveUploadRequest> {
  const part = partFor(source);
  const lines = fixture.split('\n').filter((line) => line.length > 0);
  const observations = await Promise.all(
    lines.map((line, index) =>
      observation(
        source,
        session,
        part,
        source === 'claude'
          ? `${part}:claude:id:${(JSON.parse(line) as { uuid: string }).uuid}:0`
          : `${part}:codex:line:${index}`,
        line,
      ),
    ),
  );
  const bytes = new TextEncoder().encode(fixture);
  return {
    source_session_id: session,
    observations,
    checkpoint: await checkpoint(source, session, part, observations, bytes.byteLength),
    complete_prefix_base64: base64(bytes),
  };
}

export function scope(source: ArchiveSource, session: string): ArchiveScope {
  return {
    orgId: `org-${source}-${session}`,
    userId: `user-${source}-${session}`,
    contributionId: `contribution-${source}-${session}`,
    source,
    sourceSessionId: session,
  };
}

export async function envelope(
  currentScope: ArchiveScope,
  upload: ArchiveUploadRequest,
): Promise<Record<string, unknown>> {
  return {
    scope: currentScope,
    upload,
    keyVersion: KEY_VERSION,
    wrappedKey: await archiveKey(currentScope.orgId),
  };
}

export async function call(
  stub: DurableObjectStub<ArchiveSessionLedger>,
  value: Record<string, unknown>,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await stub.fetch('https://ledger.test/commit', {
    method: 'POST',
    body: JSON.stringify(value),
  });
  return { response, body: await response.json() };
}

export function expectIntegrity(
  result: { response: Response; body: Record<string, unknown> },
  errorClass: string,
): void {
  expect(result.response.status).toBe(409);
  expect(result.body).toMatchObject({
    error: 'integrity_error',
    error_class: errorClass,
  });
}

export function newLedger(currentScope: ArchiveScope): DurableObjectStub<ArchiveSessionLedger> {
  const id = runtimeEnv.ARCHIVE_SESSION_LEDGER.idFromName(
    JSON.stringify([
      currentScope.orgId,
      currentScope.contributionId,
      currentScope.source,
      currentScope.sourceSessionId,
    ]),
  );
  return runtimeEnv.ARCHIVE_SESSION_LEDGER.get(id);
}

export type LedgerEffectRow = Record<string, string | number | null>;

export async function ledgerEffects(
  stub: DurableObjectStub<ArchiveSessionLedger>,
  currentScope: ArchiveScope,
): Promise<{
  storage: Record<string, LedgerEffectRow[]>;
  objects: { key: string; size: number }[];
}> {
  const storage = await runInDurableObject(stub, (_instance, durableState) => {
    const rows = (query: string) => [...durableState.storage.sql.exec<LedgerEffectRow>(query)];
    return {
      ledgerState: rows('SELECT id, data FROM ledger_state ORDER BY id'),
      ledgerElements: rows('SELECT sequence, data FROM ledger_elements ORDER BY sequence'),
      ledgerRanges: rows('SELECT sequence, data FROM ledger_ranges ORDER BY sequence'),
      ledgerScans: rows('SELECT part_id, data FROM ledger_scans ORDER BY part_id'),
      ledgerScanFingerprints: rows(
        'SELECT part_id, fingerprint_index, data FROM ledger_scan_fingerprints ORDER BY part_id, fingerprint_index',
      ),
      ledgerRecordVersions: rows(
        'SELECT version_key, part_id, record_identity, content_hash, sequence FROM ledger_record_versions ORDER BY version_key',
      ),
      pendingIntents: rows(
        'SELECT intent_hash, status, base_element_count, base_chain_head FROM pending_intents ORDER BY intent_hash',
      ),
      pendingIntentMetadata: rows(
        'SELECT intent_hash, part_index, data FROM pending_intent_metadata ORDER BY intent_hash, part_index',
      ),
      pendingIntentParts: rows(
        'SELECT intent_hash, object_index, part_index, data FROM pending_intent_parts ORDER BY intent_hash, object_index, part_index',
      ),
    };
  });
  const objects = (
    await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    })
  ).objects.map(({ key, size }) => ({ key, size }));
  return { storage, objects };
}

export async function seedPendingCommit(
  currentScope: ArchiveScope,
  upload: ArchiveUploadRequest,
  mutateCommit?: (commit: LedgerCommit) => void,
): Promise<{
  stub: DurableObjectStub<ArchiveSessionLedger>;
  acknowledgement: ArchiveAcknowledgement;
}> {
  const stub = newLedger(currentScope);
  const validated = await parseAndValidateUpload(upload, currentScope);
  const wrapped = await archiveKey(currentScope.orgId);
  const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
    orgId: currentScope.orgId,
    keyVersion: KEY_VERSION,
    wrappingSecretBase64: WRAPPING_SECRET,
  });
  const record = await buildRecord(validated.observations[0]!, 0, GENESIS_CHAIN_HASH);
  const recordMetadata = (({ payload: _payload, ...metadata }) => metadata)(record);
  const checkpoint = {
    kind: 'checkpoint' as const,
    archive_format_version: ARCHIVE_FORMAT_VERSION,
    chain_hash_version: CHAIN_HASH_VERSION,
    source: currentScope.source,
    source_session_id: currentScope.sourceSessionId,
    source_transcript_part_id: validated.checkpoint.source_transcript_part_id,
    checkpoint: validated.checkpoint,
    chain_sequence: 1,
    previous_chain_hash: record.chain_hash,
    chain_hash: await checkpointChainHash(record.chain_hash, 1, validated.checkpoint),
  };
  const elements = [recordMetadata, checkpoint];
  const plan = await packNewElements(
    currentScope,
    elements,
    [record, checkpoint],
    {},
    1,
    key,
    KEY_VERSION,
  );
  const state: LedgerSnapshot = {
    scope: currentScope,
    keyVersion: KEY_VERSION,
    elementCount: elements.length,
    recordCount: 1,
    chainHead: checkpoint.chain_hash,
    generation: 1,
    manifestKey: plan.manifestKey,
    manifestHeadPageKey: plan.manifestHeadPageKey,
  };
  const acknowledgement = buildAcknowledgement(state, false, 1, true, [
    ...plan.chunks.map((chunk) => chunk.objectKey),
  ]);
  const expectedObjects = [
    ...plan.chunks.map((chunk) => ({
      key: chunk.objectKey,
      body: chunk.encryptedBody,
      objectClass: 'chunk' as const,
      plaintext: chunk.plainBytes,
    })),
    {
      key: plan.manifestKey,
      body: plan.manifestBody,
      objectClass: 'manifest' as const,
      plaintext: new TextEncoder().encode(plan.manifestPlaintextBody),
    },
  ];
  const objects = expectedObjects.map(({ key: objectKey, body, objectClass }) => ({
    key: objectKey,
    body,
    objectClass,
  }));
  const commit: LedgerCommit = {
    scope: currentScope,
    keyVersion: KEY_VERSION,
    elementCount: elements.length,
    recordCount: 1,
    chainHead: checkpoint.chain_hash,
    generation: 1,
    manifestKey: plan.manifestKey,
    manifestHeadPageKey: plan.manifestHeadPageKey,
    newElements: elements,
    ranges: Object.fromEntries(
      (plan.manifest.elements ?? []).map((element) => [
        String(element.chain_sequence),
        element.byte_range,
      ]),
    ),
    scan: {
      partId: validated.checkpoint.source_transcript_part_id,
      checkpoint: validated.checkpoint,
      fingerprints: sourceFingerprints(validated.observations),
      replace: true,
    },
  };
  mutateCommit?.(commit);
  const expectedPendingObjects = expectedObjects.map(
    ({ key: objectKey, objectClass, plaintext }) => ({
      key: objectKey,
      objectClass,
      plaintextBase64: encodePendingPlaintext(plaintext),
    }),
  );
  const intentHash = await intentDigest({ scope: currentScope, upload: validated });
  const intent: PendingIntent = {
    intentHash,
    status: 'building',
    baseElementCount: 0,
    baseChainHead: GENESIS_CHAIN_HASH,
    objects,
    acknowledgement,
    commit,
    stateHash: await pendingIntentStateHash(intentHash, commit, expectedPendingObjects),
    stateAuthentication: await encryptPendingIntentState(
      intentHash,
      commit,
      expectedPendingObjects,
      key,
      currentScope.orgId,
      KEY_VERSION,
    ),
  };
  await runInDurableObject(stub, (_instance, durableState) =>
    writeIntent(durableState.storage, intent),
  );
  await runtimeEnv.ARCHIVE_STORAGE.put(plan.chunks[0]!.objectKey, plan.chunks[0]!.encryptedBody);
  return { stub, acknowledgement };
}

export async function expectAgentFactSyncAccepted(
  currentScope: ArchiveScope,
  collectorSecret: string,
): Promise<void> {
  __resetPolicyCache();
  const collectorKey = `collector:${await sha256Hex(collectorSecret)}`;
  const queueSend = vi.fn(async () => {});
  const agentEnv = {
    COLLECTOR_CREDS: {
      get: async (key: string) =>
        key === collectorKey
          ? JSON.stringify({
              orgId: currentScope.orgId,
              userId: currentScope.userId,
              collectorId: 'collector-1',
              expiresAt: Date.now() + 60_000,
              status: 'active',
              createdAt: Date.now(),
            })
          : null,
    },
    AGENT_QUEUE: { sendBatch: queueSend },
    AGENT_INGEST_LIMITER: { limit: async () => ({ success: true }) },
    CONVEX_SITE_URL: 'https://agent-convex.test',
    AGENT_INGEST_SHARED_SECRET: 'agent-shared-secret',
  } as unknown as AgentIngestEnv;
  const previousFetch = globalThis.fetch;
  const agentFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      url.origin === 'https://agent-convex.test' &&
      url.pathname === '/agent-ingest/compatibility-policy'
    ) {
      return Response.json({
        minDesktopVersion: '1.0.0',
        minParserVersion: '1.0.0',
        denylistedVersions: [],
        updatedAt: Date.now(),
      });
    }
    if (
      request.method === 'POST' &&
      url.origin === 'https://agent-convex.test' &&
      url.pathname === '/agent-ingest/claim-sessions'
    ) {
      const body = await request.json<{ sessionPks?: unknown }>();
      if (!Array.isArray(body.sessionPks)) throw new Error('claim request malformed');
      return Response.json({
        results: body.sessionPks.map((sessionPk) => ({
          sessionPk,
          status: 'claimed',
          ownerUserId: currentScope.userId,
        })),
      });
    }
    return previousFetch(input, init);
  });
  try {
    const ingestContext = createExecutionContext();
    const ingestResponse = await agentIngestApp.fetch(
      new Request('https://agent.test/v1/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Collector-Secret': collectorSecret,
        },
        body: JSON.stringify(agentIngestEnvelope()),
      }),
      agentEnv,
      ingestContext,
    );
    await waitOnExecutionContext(ingestContext);
    expect(ingestResponse.status).toBe(202);
    expect(await ingestResponse.json()).toMatchObject({ accepted: true, sessions: 1 });
    expect(queueSend).toHaveBeenCalledTimes(1);
  } finally {
    agentFetch.mockRestore();
  }
}

export {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
  decryptArchiveObject,
  sha256Hex,
  unwrapArchiveEncryptionKey,
  ARCHIVE_FORMAT_VERSION,
  CHAIN_HASH_VERSION,
  GENESIS_CHAIN_HASH,
  MAX_CHUNK_BYTES,
  MAX_UPLOAD_OBSERVATIONS,
  validateObservation,
  canonicalElement,
  checkpointChainHash,
  recordChainHash,
  archiveSessionPrefix,
  packNewElements,
  decompress,
  storageBudgetObject,
  app,
  payloadBytes,
  prefixChainHash,
  MAX_ARCHIVE_UPLOAD_BYTES,
  commitArchiveSession,
  ARCHIVE_STORAGE_CAP_BYTES,
  readLedgerScan,
  readLedgerSnapshot,
  discardPendingIntent,
  markIntentReady,
  markIntentWriteAuthorized,
  readPendingIntent,
  claudeFixture,
  codexFixture,
  rustWireSessionJson,
  agentIngestApp,
  __resetPolicyCache,
  agentIngestEnvelope,
};

export type {
  ArchiveObjectEnvelope,
  ArchiveScope,
  ArchiveSource,
  ArchiveUploadRequest,
  CompletedScanCheckpoint,
  StoredElement,
  StoredRecord,
  ArchiveSessionLedger,
  StorageBudget,
  ArchiveApiEnv,
  ArchiveAcknowledgement,
  LedgerSnapshot,
  PendingIntent,
  AgentIngestEnv,
};
