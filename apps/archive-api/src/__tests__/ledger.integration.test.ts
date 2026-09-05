/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  env as workerEnv,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
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
import { storageBudgetObject, verifyOrPutImmutableObject } from '../archive-r2';
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
import type { ArchiveAcknowledgement, LedgerSnapshot } from '../archive-ledger-state';
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

const WRAPPING_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const KEY_VERSION = 1;
const runtimeEnv = workerEnv as unknown as {
  COLLECTOR_CREDS: KVNamespace;
  ARCHIVE_SESSION_LEDGER: DurableObjectNamespace<ArchiveSessionLedger>;
  STORAGE_BUDGET: DurableObjectNamespace<StorageBudget>;
  ARCHIVE_STORAGE: R2Bucket;
  ARCHIVE_KEY_VERSION: string;
  ARCHIVE_KEY_WRAPPING_SECRET: string;
};
const wrappedKeys = new Map<string, string>();

function partFor(source: ArchiveSource): string {
  return source === 'claude' ? 'claude:part:parent' : 'codex:part:primary';
}

function base64(bytes: Uint8Array): string {
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

function exactPrefix(observations: ArchiveUploadRequest['observations']): Uint8Array {
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

async function digest(bytes: Uint8Array): Promise<string> {
  return `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

async function observation(
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

async function checkpoint(
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

async function archiveKey(orgId: string) {
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

async function fixtureUpload(
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

function scope(source: ArchiveSource, session: string): ArchiveScope {
  return {
    orgId: `org-${source}-${session}`,
    userId: `user-${source}-${session}`,
    contributionId: `contribution-${source}-${session}`,
    source,
    sourceSessionId: session,
  };
}

async function envelope(
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

async function call(
  stub: DurableObjectStub<ArchiveSessionLedger>,
  value: Record<string, unknown>,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await stub.fetch('https://ledger.test/commit', {
    method: 'POST',
    body: JSON.stringify(value),
  });
  return { response, body: await response.json() };
}

function newLedger(currentScope: ArchiveScope): DurableObjectStub<ArchiveSessionLedger> {
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

type LedgerEffectRow = Record<string, string | number | null>;

async function ledgerEffects(
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

async function seedPendingCommit(
  currentScope: ArchiveScope,
  upload: ArchiveUploadRequest,
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
  const commit = {
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

describe('Archive Session Ledger', () => {
  beforeEach(() => {
    expect(runtimeEnv.ARCHIVE_KEY_WRAPPING_SECRET).toBe(WRAPPING_SECRET);
  });

  it.each(['claude', 'codex'] as const)(
    'serializes concurrent first use and lost-response retry for %s',
    async (source) => {
      const currentScope = scope(source, `first-use-${crypto.randomUUID()}`);
      const record = await observation(
        source,
        currentScope.sourceSessionId,
        partFor(source),
        'r1',
        '"first"',
      );
      const upload = {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: await checkpoint(source, currentScope.sourceSessionId, partFor(source), [
          record,
        ]),
        complete_prefix_base64: base64(exactPrefix([record])),
      };
      const firstStub = newLedger(currentScope);
      const secondStub = newLedger(currentScope);
      const [first, second] = await Promise.all([
        call(firstStub, await envelope(currentScope, upload)),
        call(secondStub, await envelope(currentScope, upload)),
      ]);
      expect(first.response.status).toBe(200);
      expect(second.response.status).toBe(200);
      expect(first.body.manifest_key).toBe(second.body.manifest_key);
      expect(first.body.generation).toBe(1);

      const retry = await call(firstStub, await envelope(currentScope, upload));
      expect(retry.response.status).toBe(200);
      expect(retry.body.duplicate).toBe(false);
      expect(retry.body.manifest_key).toBe(first.body.manifest_key);
      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(listed.objects).toHaveLength(2);
      expect(await archiveSessionPrefix(currentScope)).toContain('/contributions/');
      expect(await archiveSessionPrefix(currentScope)).not.toContain(currentScope.contributionId);
      const intentState = await runInDurableObject(firstStub, (_instance, state) => ({
        pendingParts: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_intent_parts',
          ),
        ][0]?.count,
        status: [
          ...state.storage.sql.exec<{ status: string }>(
            'SELECT status FROM pending_intents LIMIT 1',
          ),
        ][0]?.status,
      }));
      expect(intentState.pendingParts).toBe(0);
      expect(intentState.status).toBe('committed');
    },
  );

  it('uses a partial index for active intent recovery after many committed generations', async () => {
    const currentScope = scope('codex', `active-intent-index-${crypto.randomUUID()}`);
    const stub = newLedger(currentScope);
    const result = await runInDurableObject(stub, (_instance, durableState) => {
      for (let index = 0; index < 2048; index++) {
        durableState.storage.sql.exec(
          'INSERT INTO pending_intents (intent_hash, status, base_element_count, base_chain_head) VALUES (?, ?, ?, ?)',
          `committed-intent-${index}`,
          'committed',
          index,
          GENESIS_CHAIN_HASH,
        );
      }
      const explain = () => [
        ...durableState.storage.sql.exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT intent_hash FROM pending_intents WHERE status IN ('building', 'ready', 'write_authorized') LIMIT 1",
        ),
      ];
      const planBefore = explain();
      durableState.storage.sql.exec(
        'INSERT INTO pending_intents (intent_hash, status, base_element_count, base_chain_head) VALUES (?, ?, ?, ?)',
        'active-intent',
        'building',
        2048,
        GENESIS_CHAIN_HASH,
      );
      return {
        committedCount: [
          ...durableState.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM pending_intents WHERE status = 'committed'",
          ),
        ][0]?.count,
        planBefore,
        planAfter: explain(),
        pendingIntentHash: [
          ...durableState.storage.sql.exec<{ intent_hash: string }>(
            "SELECT intent_hash FROM pending_intents WHERE status = 'building' LIMIT 1",
          ),
        ][0]?.intent_hash,
      };
    });
    const assertIndexed = (plan: { detail: string }[]) => {
      expect(plan.some((row) => row.detail.includes('pending_intents_active_status'))).toBe(true);
      expect(plan.some((row) => /SCAN pending_intents(?! USING INDEX)/.test(row.detail))).toBe(
        false,
      );
    };
    expect(result.committedCount).toBe(2048);
    assertIndexed(result.planBefore);
    assertIndexed(result.planAfter);
    expect(result.pendingIntentHash).toBe('active-intent');
  });

  it('bounds near-cap request counts before hashing and rejects over-cap requests', async () => {
    const nearScope = scope('codex', `incoming-count-near-${crypto.randomUUID()}`);
    const nearCap = await call(
      newLedger(nearScope),
      await envelope(nearScope, {
        source_session_id: nearScope.sourceSessionId,
        observations: new Array(MAX_UPLOAD_OBSERVATIONS).fill(null),
        checkpoint: null,
      } as unknown as ArchiveUploadRequest),
    );
    expect(nearCap.response.status).toBe(400);
    expect(nearCap.body.error).toBe('invalid_observation');

    const overScope = scope('codex', `incoming-count-over-${crypto.randomUUID()}`);
    const rejected = await call(
      newLedger(overScope),
      await envelope(overScope, {
        source_session_id: overScope.sourceSessionId,
        observations: new Array(MAX_UPLOAD_OBSERVATIONS + 1).fill(null),
        checkpoint: null,
      } as unknown as ArchiveUploadRequest),
    );
    expect(rejected.response.status).toBe(413);
    expect(rejected.body.error).toBe('archive_upload_observation_limit');
    const stateRows = await runInDurableObject(newLedger(overScope), (_instance, state) => [
      ...state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_state'),
    ]);
    expect(stateRows[0]?.count).toBe(0);
    const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(overScope),
    });
    expect(stored.objects).toHaveLength(0);
  });

  it('commits the exact per-request observation boundary and appends afterward', async () => {
    const currentScope: ArchiveScope = {
      orgId: 'org-exact-max',
      userId: 'user-exact-max',
      contributionId: 'contribution-exact-max',
      source: 'codex',
      sourceSessionId: 'session-exact-max',
    };
    const part = partFor(currentScope.source);
    const payload = '{}';
    const contentSha256 = await digest(new TextEncoder().encode(payload));
    const observations: Awaited<ReturnType<typeof observation>>[] = Array.from(
      { length: MAX_UPLOAD_OBSERVATIONS },
      (_, index) => ({
        archive_format_version: ARCHIVE_FORMAT_VERSION,
        chain_hash_version: CHAIN_HASH_VERSION,
        source: currentScope.source,
        source_session_id: currentScope.sourceSessionId,
        source_transcript_part_id: part,
        source_record_identity: `${part}:codex:line:${index}`,
        observed_at: 1_700_000_000_000,
        payload_encoding: 'utf8' as const,
        payload,
        content_sha256: contentSha256,
      }),
    );
    const upload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations,
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        part,
        observations,
      ),
      complete_prefix_base64: base64(
        new TextEncoder().encode(payload.concat('\n').repeat(MAX_UPLOAD_OBSERVATIONS)),
      ),
    };
    const stub = newLedger(currentScope);
    const rejected = await call(stub, await envelope(currentScope, upload));
    expect(rejected.response.status).toBe(200);
    expect(rejected.body.record_count).toBe(MAX_UPLOAD_OBSERVATIONS);

    const stateCounts = await runInDurableObject(stub, (_instance, state) => ({
      ledgerState: [
        ...state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_state'),
      ][0]?.count,
      ledgerElements: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_elements',
        ),
      ][0]?.count,
      pendingIntents: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM pending_intents',
        ),
      ][0]?.count,
    }));
    expect(stateCounts.ledgerState).toBe(1);
    expect(stateCounts.ledgerElements).toBe(MAX_UPLOAD_OBSERVATIONS + 1);
    expect(stateCounts.pendingIntents).toBe(1);
    const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(stored.objects.length).toBeGreaterThan(2);

    const appended = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      'codex:part:primary:codex:line:after-max',
      '"after-max"',
    );
    const appendedPrefix = new TextEncoder().encode('"after-max"\n');
    const appendedCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      [appended],
    );
    const prior = upload.checkpoint;
    const deltaCheckpoint = {
      ...appendedCheckpoint,
      record_count: MAX_UPLOAD_OBSERVATIONS + 1,
      last_source_record_identity: appended.source_record_identity,
      last_complete_byte_offset: prior.last_complete_byte_offset + appendedPrefix.byteLength,
      observed_file_size: prior.observed_file_size + appendedPrefix.byteLength,
      first_observed_at: prior.first_observed_at,
      complete_prefix_sha256: await digest(
        new TextEncoder().encode(
          `${payload.concat('\n').repeat(MAX_UPLOAD_OBSERVATIONS)}"after-max"\n`,
        ),
      ),
      prefix_chain_sha256: await prefixChainHash(prior.prefix_chain_sha256, appendedPrefix),
    };
    const appendResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [appended],
        checkpoint: deltaCheckpoint,
        prior_checkpoint: prior,
        append_proof: {
          prior_prefix_chain_sha256: prior.prefix_chain_sha256,
          appended_prefix_base64: base64(appendedPrefix),
        },
      }),
    );
    expect(appendResult.response.status).toBe(200);
    expect(appendResult.body.record_count).toBe(MAX_UPLOAD_OBSERVATIONS + 1);
  });

  it('keeps manifest and intent work bounded across more than 16,384 records', async () => {
    const currentScope = scope('codex', `paged-lifetime-${crypto.randomUUID()}`);
    const stub = newLedger(currentScope);
    const part = partFor(currentScope.source);
    const firstPayload = '{}';
    const firstHash = await digest(new TextEncoder().encode(firstPayload));
    const firstRecords: ArchiveUploadRequest['observations'] = Array.from(
      { length: MAX_UPLOAD_OBSERVATIONS },
      (_, index) => ({
        archive_format_version: ARCHIVE_FORMAT_VERSION,
        chain_hash_version: CHAIN_HASH_VERSION,
        source: currentScope.source,
        source_session_id: currentScope.sourceSessionId,
        source_transcript_part_id: part,
        source_record_identity: `${part}:codex:line:${index}`,
        observed_at: 1_700_000_000_000,
        payload_encoding: 'utf8' as const,
        payload: firstPayload,
        content_sha256: firstHash,
      }),
    );
    const firstBytes = new TextEncoder().encode(
      firstPayload.concat('\n').repeat(firstRecords.length),
    );
    let historicalPrefix = firstBytes;
    let priorCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      part,
      firstRecords,
    );
    const firstResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: firstRecords,
        checkpoint: priorCheckpoint,
        complete_prefix_base64: base64(firstBytes),
      }),
    );
    expect(firstResult.response.status).toBe(200);

    const appendBatchSize = 4096;
    for (let batch = 0; batch < 4; batch++) {
      const payload = JSON.stringify({ batch, value: 'append' });
      const contentSha256 = await digest(new TextEncoder().encode(payload));
      const records: ArchiveUploadRequest['observations'] = Array.from(
        { length: appendBatchSize },
        (_, index) => ({
          archive_format_version: ARCHIVE_FORMAT_VERSION,
          chain_hash_version: CHAIN_HASH_VERSION,
          source: currentScope.source,
          source_session_id: currentScope.sourceSessionId,
          source_transcript_part_id: part,
          source_record_identity: `${part}:codex:line:${MAX_UPLOAD_OBSERVATIONS + batch * appendBatchSize + index}`,
          observed_at: 1_700_000_000_001 + batch,
          payload_encoding: 'utf8' as const,
          payload,
          content_sha256: contentSha256,
        }),
      );
      const appendedBytes = new TextEncoder().encode(
        records.map((record) => `${record.payload}\n`).join(''),
      );
      const nextPrefix = new Uint8Array(historicalPrefix.byteLength + appendedBytes.byteLength);
      nextPrefix.set(historicalPrefix);
      nextPrefix.set(appendedBytes, historicalPrefix.byteLength);
      const batchCheckpoint = await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        part,
        records,
      );
      const nextCheckpoint: CompletedScanCheckpoint = {
        ...batchCheckpoint,
        record_count: priorCheckpoint.record_count + records.length,
        last_source_record_identity: records.at(-1)!.source_record_identity,
        last_complete_byte_offset: nextPrefix.byteLength,
        observed_file_size: nextPrefix.byteLength,
        complete_prefix_sha256: await digest(nextPrefix),
        prefix_chain_sha256: await prefixChainHash(
          priorCheckpoint.prefix_chain_sha256,
          appendedBytes,
        ),
        first_observed_at: priorCheckpoint.first_observed_at,
      };
      const result = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: records,
          checkpoint: nextCheckpoint,
          prior_checkpoint: priorCheckpoint,
          append_proof: {
            prior_prefix_chain_sha256: priorCheckpoint.prefix_chain_sha256,
            appended_prefix_base64: base64(appendedBytes),
          },
        }),
      );
      expect(result.response.status).toBe(200);
      expect(result.body.record_count).toBe(
        MAX_UPLOAD_OBSERVATIONS + (batch + 1) * appendBatchSize,
      );
      const intentBounds = await runInDurableObject(stub, (_instance, state) => ({
        pendingParts: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_intent_parts',
          ),
        ][0]?.count,
        committedMetadataBytes: [
          ...state.storage.sql.exec<{ bytes: number }>(
            'SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM pending_intent_metadata',
          ),
        ][0]?.bytes,
      }));
      expect(intentBounds.pendingParts).toBe(0);
      expect(intentBounds.committedMetadataBytes).toBeLessThan(16 * 1024);
      historicalPrefix = nextPrefix;
      priorCheckpoint = nextCheckpoint;
    }

    const rootKey = (
      await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [],
          checkpoint: {
            ...priorCheckpoint,
            observed_file_size: priorCheckpoint.observed_file_size + 1,
          },
          prior_checkpoint: priorCheckpoint,
          append_proof: {
            prior_prefix_chain_sha256: priorCheckpoint.prefix_chain_sha256,
            appended_prefix_base64: '',
          },
        }),
      )
    ).body.manifest_key as string;
    const manifestObject = await runtimeEnv.ARCHIVE_STORAGE.get(rootKey);
    if (!manifestObject) throw new Error('lifetime manifest root missing');
    const key = await unwrapArchiveEncryptionKey(JSON.parse(await archiveKey(currentScope.orgId)), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const decodeManifest = async (keyName: string) => {
      const object = await runtimeEnv.ARCHIVE_STORAGE.get(keyName);
      if (!object) throw new Error('lifetime manifest page missing');
      return JSON.parse(
        new TextDecoder().decode(
          await decryptArchiveObject(JSON.parse(await object.text()), {
            key,
            orgId: currentScope.orgId,
            objectKey: keyName,
            objectClass: 'manifest',
            keyVersion: KEY_VERSION,
          }),
        ),
      ) as {
        elements?: { chain_sequence: number; byte_range: { start: number; end: number } }[];
        pages?: { page_key: string; element_count: number }[];
        previous_page_key?: string;
        element_count: number;
      };
    };
    const root = (await decodeManifest(rootKey)) as {
      pages: { page_key: string; element_count: number }[];
      element_count: number;
    };
    expect(root.pages).toHaveLength(1);
    const seen = new Set<string>();
    const sequences = new Set<number>();
    const visit = async (keyName: string): Promise<void> => {
      if (seen.has(keyName)) return;
      seen.add(keyName);
      const page = await decodeManifest(keyName);
      if (page.elements) {
        for (const element of page.elements) {
          expect(element.byte_range.end).toBeGreaterThan(element.byte_range.start);
          sequences.add(element.chain_sequence);
        }
        return;
      }
      expect(page.pages?.length ?? 0).toBeLessThanOrEqual(128);
      for (const reference of page.pages ?? []) await visit(reference.page_key);
      if (page.previous_page_key) await visit(page.previous_page_key);
    };
    await visit(root.pages[0]!.page_key);
    expect(sequences.size).toBe(MAX_UPLOAD_OBSERVATIONS + 1 + 4 * (appendBatchSize + 1));
    expect(root.element_count).toBe(sequences.size);
    expect(seen.size).toBe(
      Math.ceil((MAX_UPLOAD_OBSERVATIONS + 1) / 256) +
        1 +
        4 * (Math.ceil((appendBatchSize + 1) / 256) + 1),
    );
  }, 30_000);

  it('rejects an over-cap handler upload before resolving the real ledger namespace', async () => {
    const currentScope = scope('codex', `handler-over-cap-${crypto.randomUUID()}`);
    const secret = 'handler-over-cap-collector-secret';
    const hashedSecret = await sha256Hex(secret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'handler-over-cap-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    let idFromNameCalls = 0;
    let keyRequests = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'enrollment-over-cap',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'handler-over-cap-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        keyRequests++;
        throw new Error('key custody must not be reached');
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const realNamespace = runtimeEnv.ARCHIVE_SESSION_LEDGER;
    const guardedNamespace = new Proxy(realNamespace, {
      get(target, property, receiver) {
        if (property === 'idFromName') {
          return (name: string) => {
            idFromNameCalls++;
            return target.idFromName(name);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: guardedNamespace,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;

    try {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': secret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify({
            source_session_id: currentScope.sourceSessionId,
            observations: new Array(MAX_UPLOAD_OBSERVATIONS + 1).fill(null),
            checkpoint: null,
          }),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'upload_too_large' });
      expect(idFromNameCalls).toBe(0);
      expect(keyRequests).toBe(0);
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects).toHaveLength(0);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects malformed uploads before archive key, DO, state, or R2 access', async () => {
    const currentScope = scope('codex', `handler-validation-${crypto.randomUUID()}`);
    const collectorSecret = 'handler-validation-collector-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'handler-validation-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'handler-validation-record',
      '"valid"',
    );
    const validUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const nonJsonRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'handler-validation-non-json',
      'not-json',
    );
    const nonJsonUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [nonJsonRecord],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [nonJsonRecord],
      ),
      complete_prefix_base64: base64(exactPrefix([nonJsonRecord])),
    };
    const emptyCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [],
    );
    const malformedUploads = [
      {
        ...validUpload,
        observations: [
          { ...record, content_sha256: await digest(new TextEncoder().encode('wrong')) },
        ],
      },
      {
        ...validUpload,
        observations: [{ ...record, source_transcript_part_id: 'codex:part:invalid' }],
      },
      { ...validUpload, checkpoint: null },
      {
        ...validUpload,
        prior_checkpoint: emptyCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: `sha256:${'11'.repeat(32)}`,
          appended_prefix_base64: base64(new TextEncoder().encode(`${record.payload}\n`)),
        },
      },
      { ...validUpload, complete_prefix_base64: undefined },
      nonJsonUpload,
    ];
    let idFromNameCalls = 0;
    let keyRequests = 0;
    const realNamespace = runtimeEnv.ARCHIVE_SESSION_LEDGER;
    const guardedNamespace = new Proxy(realNamespace, {
      get(target, property, receiver) {
        if (property === 'idFromName') {
          return (name: string) => {
            idFromNameCalls++;
            return target.idFromName(name);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'handler-validation-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'handler-validation-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        keyRequests++;
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: guardedNamespace,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;
    try {
      for (const [index, upload] of malformedUploads.entries()) {
        const executionContext = createExecutionContext();
        const response = await app.fetch(
          new Request('https://archive.test/v1/archive/uploads', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Trace-Flow-Collector-Secret': collectorSecret,
              'X-Trace-Flow-Archive-Source': currentScope.source,
            },
            body: JSON.stringify(upload),
          }),
          handlerEnv,
          executionContext,
        );
        await waitOnExecutionContext(executionContext);
        expect(response.status).toBe([400, 400, 400, 409, 409, 400][index]);
        await expect(response.json()).resolves.toMatchObject({
          error: 'upload_rejected',
          reason: [
            'payload_hash_mismatch',
            'invalid_transcript_part_id',
            'invalid_checkpoint',
            'historical_prefix_changed',
            'missing_historical_prefix_proof',
            'checkpoint_prefix_unverifiable',
          ][index],
        });
      }
      expect(idFromNameCalls).toBe(0);
      expect(keyRequests).toBe(0);
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects).toHaveLength(0);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects lone surrogate scope values before deriving archive prefixes', async () => {
    const currentScope = scope('claude', 'well-formed-unicode');
    const replacementPrefix = await archiveSessionPrefix({
      ...currentScope,
      sourceSessionId: 'session-\ufffd',
    });
    expect(replacementPrefix).toContain('/sessions/claude/');
    for (const sourceSessionId of ['session-\ud800', 'session-\udc00']) {
      await expect(
        archiveSessionPrefix({ ...currentScope, sourceSessionId }),
      ).rejects.toMatchObject({ errorClass: 'invalid_scope' });
    }
    const validRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'identity-valid',
      '{}',
    );
    for (const surrogate of ['\ud800', '\udc00']) {
      await expect(
        validateObservation(
          { ...validRecord, source_record_identity: `identity-${surrogate}` },
          { source: currentScope.source, sourceSessionId: currentScope.sourceSessionId },
        ),
      ).rejects.toMatchObject({ errorClass: 'invalid_record_identity' });
      for (const field of ['orgId', 'userId', 'contributionId'] as const) {
        await expect(
          archiveSessionPrefix({
            ...currentScope,
            [field]: `${currentScope[field]}-${surrogate}`,
          }),
        ).rejects.toMatchObject({ errorClass: 'invalid_scope' });
      }
    }
  });

  it('propagates concurrent handler acknowledgements for two enrolled collectors', async () => {
    const currentScope = scope('claude', `handler-first-use-${crypto.randomUUID()}`);
    const identities = [
      { secret: 'handler-collector-secret-one', collectorId: 'handler-collector-one' },
      { secret: 'handler-collector-secret-two', collectorId: 'handler-collector-two' },
    ];
    const hashedIdentities = await Promise.all(
      identities.map(async (identity) => ({
        ...identity,
        hashedSecret: await sha256Hex(identity.secret),
      })),
    );
    for (const identity of hashedIdentities) {
      await runtimeEnv.COLLECTOR_CREDS.put(
        `collector:${identity.hashedSecret}`,
        JSON.stringify({
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: identity.collectorId,
          expiresAt: Date.now() + 3_600_000,
          status: 'active',
          createdAt: Date.now(),
        }),
      );
    }

    const policyRequests: { collectorId: string; hashedSecret: string }[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.origin !== 'https://archive-convex.test') {
        throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
      }
      if (url.pathname === '/archive-api/authorize-write') {
        const body = await request.json<{ collectorId?: unknown; hashedSecret?: unknown }>();
        const identity = hashedIdentities.find(
          (candidate) =>
            candidate.collectorId === body.collectorId &&
            candidate.hashedSecret === body.hashedSecret,
        );
        if (!identity) return Response.json({ allowed: false, reason: 'not_enrolled' });
        policyRequests.push({
          collectorId: identity.collectorId,
          hashedSecret: identity.hashedSecret,
        });
        return Response.json({
          allowed: true,
          enrollmentId: `enrollment-${identity.collectorId}`,
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: identity.collectorId,
          collectorCredentialId: identity.hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });

    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: runtimeEnv.ARCHIVE_SESSION_LEDGER,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'handler-record-1',
      '"HANDLER_PLAINTEXT_MARKER"',
    );
    const upload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    };

    try {
      const send = async (secret: string, requestUpload = upload) => {
        const executionContext = createExecutionContext();
        const response = await app.fetch(
          new Request('https://archive.test/v1/archive/uploads', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Trace-Flow-Collector-Secret': secret,
              'X-Trace-Flow-Archive-Source': currentScope.source,
            },
            body: JSON.stringify(requestUpload),
          }),
          handlerEnv,
          executionContext,
        );
        await waitOnExecutionContext(executionContext);
        return { response, body: await response.json<Record<string, unknown>>() };
      };
      const results = await Promise.all(identities.map((identity) => send(identity.secret)));
      const first = results[0];
      const second = results[1];
      if (!first || !second) throw new Error('handler acknowledgement missing');
      expect(first.response.status).toBe(200);
      expect(second.response.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(first.body).toMatchObject({
        status: 'acknowledged',
        source: currentScope.source,
        source_session_id: currentScope.sourceSessionId,
        contribution_id: currentScope.contributionId,
        appended_records: 1,
        generation: 1,
      });
      const unchangedPrefix = new TextEncoder().encode(`${record.payload}\n`);
      const unchanged = await send(identities[1]!.secret, {
        ...upload,
        complete_prefix_base64: base64(unchangedPrefix),
      });
      expect(unchanged.response.status).toBe(200);
      expect(unchanged.body).toMatchObject({
        duplicate: false,
        generation: 1,
        record_count: 1,
        manifest_key: first.body.manifest_key,
      });

      const changedPrefix = new TextEncoder().encode(`\n${record.payload}\n`);
      const changed = await send(identities[1]!.secret, {
        ...upload,
        checkpoint: {
          ...upload.checkpoint,
          last_complete_byte_offset: changedPrefix.byteLength,
          observed_file_size: changedPrefix.byteLength,
          complete_prefix_sha256: await digest(changedPrefix),
          prefix_chain_sha256: await prefixChainHash(undefined, changedPrefix),
        },
        complete_prefix_base64: base64(changedPrefix),
      });
      expect(changed.response.status).toBe(409);
      expect(changed.body).toMatchObject({
        error: 'upload_rejected',
        reason: 'historical_prefix_changed',
      });
      expect(new Set(policyRequests.map((request) => request.collectorId))).toEqual(
        new Set(identities.map((identity) => identity.collectorId)),
      );
      expect(policyRequests).toHaveLength(identities.length * 4);

      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(listed.objects).toHaveLength(2);
      const stateRows = await runInDurableObject(newLedger(currentScope), (_instance, state) => [
        ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
      ]);
      expect(JSON.parse(stateRows[0]!.data)).toMatchObject({ generation: 1 });
      const wrapped = await archiveKey(currentScope.orgId);
      const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
        orgId: currentScope.orgId,
        keyVersion: KEY_VERSION,
        wrappingSecretBase64: WRAPPING_SECRET,
      });
      for (const listedObject of listed.objects) {
        const raw = await runtimeEnv.ARCHIVE_STORAGE.get(listedObject.key);
        if (!raw) throw new Error('archive object missing');
        const rawText = await raw.text();
        expect(rawText).not.toContain(record.payload);
        const envelope: ArchiveObjectEnvelope = JSON.parse(rawText);
        expect(envelope.objectKey).toBe(listedObject.key);
        expect(envelope.ciphertext).toEqual(expect.any(String));
        await expect(
          decryptArchiveObject(envelope, {
            key,
            orgId: currentScope.orgId,
            objectKey: listedObject.key,
            objectClass: envelope.objectClass,
            keyVersion: KEY_VERSION,
          }),
        ).resolves.toBeInstanceOf(Uint8Array);
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('deduplicates concurrent stale deltas from two enrolled collectors', async () => {
    const currentScope = scope('codex', `handler-stale-delta-${crypto.randomUUID()}`);
    const identities = [
      { secret: 'stale-delta-collector-one', collectorId: 'stale-delta-one' },
      { secret: 'stale-delta-collector-two', collectorId: 'stale-delta-two' },
    ];
    const enrolled = await Promise.all(
      identities.map(async (identity) => ({
        ...identity,
        hashedSecret: await sha256Hex(identity.secret),
      })),
    );
    for (const identity of enrolled) {
      await runtimeEnv.COLLECTOR_CREDS.put(
        `collector:${identity.hashedSecret}`,
        JSON.stringify({
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: identity.collectorId,
          expiresAt: Date.now() + 3_600_000,
          status: 'active',
          createdAt: Date.now(),
        }),
      );
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        const body = await request.json<{ collectorId?: unknown; hashedSecret?: unknown }>();
        const identity = enrolled.find(
          (candidate) =>
            candidate.collectorId === body.collectorId &&
            candidate.hashedSecret === body.hashedSecret,
        );
        if (!identity) return Response.json({ allowed: false, reason: 'not_enrolled' });
        return Response.json({
          allowed: true,
          enrollmentId: `enrollment-${identity.collectorId}`,
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: identity.collectorId,
          collectorCredentialId: identity.hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: runtimeEnv.ARCHIVE_SESSION_LEDGER,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;
    const firstRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'codex:part:primary:codex:line:0',
      '"one"',
      100,
    );
    const firstCheckpoint = await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [firstRecord],
    );
    const firstUpload: ArchiveUploadRequest = {
      source_session_id: currentScope.sourceSessionId,
      observations: [firstRecord],
      checkpoint: firstCheckpoint,
      complete_prefix_base64: base64(exactPrefix([firstRecord])),
    };
    const secondAt101 = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'codex:part:primary:codex:line:1',
      '"two"',
      101,
    );
    const secondAt202 = { ...secondAt101, observed_at: 202 };
    const suffix = new TextEncoder().encode(`${secondAt101.payload}\n`);
    const deltaCheckpoint = {
      ...(await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [firstRecord, secondAt101],
      )),
      first_observed_at: firstCheckpoint.first_observed_at,
      prefix_chain_sha256: await prefixChainHash(firstCheckpoint.prefix_chain_sha256, suffix),
    };
    const deltaUpload = (
      record: Awaited<ReturnType<typeof observation>>,
    ): ArchiveUploadRequest => ({
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: deltaCheckpoint,
      prior_checkpoint: firstCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
        appended_prefix_base64: base64(suffix),
      },
    });
    const send = async (secret: string, upload: ArchiveUploadRequest) => {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': secret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(upload),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      return { response, body: await response.json<Record<string, unknown>>() };
    };
    try {
      const initial = await send(enrolled[0]!.secret, firstUpload);
      expect(initial.response.status).toBe(200);
      const [firstDelta, secondDelta] = await Promise.all([
        send(enrolled[0]!.secret, deltaUpload(secondAt101)),
        send(enrolled[1]!.secret, deltaUpload(secondAt202)),
      ]);
      expect(firstDelta.response.status).toBe(200);
      expect(secondDelta.response.status).toBe(200);
      expect(firstDelta.body.manifest_key).toBe(secondDelta.body.manifest_key);
      expect(firstDelta.body).toMatchObject({ record_count: 2, generation: 2 });
      expect(secondDelta.body).toMatchObject({ record_count: 2, generation: 2 });
      expect([firstDelta.body.appended_records, secondDelta.body.appended_records].sort()).toEqual([
        0, 1,
      ]);
      const state = await runInDurableObject(
        newLedger(currentScope),
        (_instance, durableState) => ({
          elements: [
            ...durableState.storage.sql.exec<{ count: number }>(
              'SELECT COUNT(*) AS count FROM ledger_elements',
            ),
          ][0]?.count,
          versions: [
            ...durableState.storage.sql.exec<{ count: number }>(
              'SELECT COUNT(*) AS count FROM ledger_record_versions',
            ),
          ][0]?.count,
        }),
      );
      expect(state).toEqual({ elements: 4, versions: 2 });
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects).toHaveLength(6);
      for (const object of stored.objects) {
        const raw = await runtimeEnv.ARCHIVE_STORAGE.get(object.key);
        expect(await raw!.text()).not.toContain(secondAt101.payload);
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('accepts serialized collector-archive wire requests through the handler', async () => {
    const currentScope: ArchiveScope = {
      orgId: 'org-rust-wire',
      userId: 'user-rust-wire',
      contributionId: 'contribution-rust-wire',
      source: 'claude',
      sourceSessionId: 'session-1',
    };
    const collectorSecret = 'rust-wire-collector-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'rust-wire-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'rust-wire-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'rust-wire-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: runtimeEnv.ARCHIVE_SESSION_LEDGER,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;
    const wire = JSON.parse(rustWireSessionJson) as Record<string, ArchiveUploadRequest>;
    const send = async (upload: ArchiveUploadRequest) => {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': collectorSecret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(upload),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      return { response, body: await response.json<Record<string, unknown>>() };
    };
    try {
      const initial = await send(wire.initial!);
      expect(initial.response.status).toBe(200);
      expect(initial.body.record_count).toBe(1);
      const eof = await send(wire.eof!);
      expect(eof.response.status).toBe(200);
      expect(eof.body).toMatchObject({ record_count: 2, appended_records: 1 });
      const append = await send(wire.append!);
      expect(append.response.status).toBe(200);
      expect(append.body).toMatchObject({ record_count: 3, appended_records: 1 });
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects.length).toBeGreaterThan(2);
      for (const object of stored.objects) {
        const raw = await runtimeEnv.ARCHIVE_STORAGE.get(object.key);
        expect(await raw!.text()).not.toContain('"uuid":"r');
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('accepts the Rust vertical-tab fixture with the Worker incomplete-tail disposition', async () => {
    const currentScope = scope('claude', 'vertical-tab-session');
    const collectorSecret = 'vertical-tab-fixture-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'vertical-tab-fixture-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'vertical-tab-fixture-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'vertical-tab-fixture-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const wire = JSON.parse(rustWireSessionJson) as Record<string, ArchiveUploadRequest>;
    const context = createExecutionContext();
    try {
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': collectorSecret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(wire.vertical_tab),
        }),
        {
          ...runtimeEnv,
          CONVEX_SITE_URL: 'https://archive-convex.test',
          ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
        },
        context,
      );
      await waitOnExecutionContext(context);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ record_count: 1, appended_records: 1 });
      const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(stored.objects.length).toBeGreaterThan(0);
      for (const object of stored.objects) {
        expect(await (await runtimeEnv.ARCHIVE_STORAGE.get(object.key))!.text()).not.toContain(
          '"uuid":"vt"',
        );
      }
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects a bad payload batch without acknowledging or advancing the ledger', async () => {
    const currentScope = scope('claude', `first-failure-${crypto.randomUUID()}`);
    const record = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"first"',
    );
    const badRecord = {
      ...record,
      content_sha256: await digest(new TextEncoder().encode('wrong')),
    };
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint('claude', currentScope.sourceSessionId, partFor('claude'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const stub = newLedger(currentScope);
    const rejected = await call(
      stub,
      await envelope(currentScope, { ...upload, observations: [badRecord] }),
    );
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toBe('payload_hash_mismatch');
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      ledgerState: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_state',
        ),
      ][0]?.count,
      ledgerElements: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_elements',
        ),
      ][0]?.count,
    }));
    expect(state).toEqual({ ledgerState: 0, ledgerElements: 0 });
    const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(listed.objects).toHaveLength(0);
  });

  it('resumes a pending intent after a partial immutable R2 write', async () => {
    const currentScope = scope('codex', `pending-${crypto.randomUUID()}`);
    const transcriptMarker = 'known-transcript-marker-should-not-persist';
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      JSON.stringify({ transcript: transcriptMarker }),
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const { stub, acknowledgement } = await seedPendingCommit(currentScope, upload);
    const authorizedIntent = await runInDurableObject(stub, (_instance, state) => {
      const pending = readPendingIntent(state.storage);
      if (!pending) throw new Error('pending intent missing');
      markIntentReady(state.storage, pending.intentHash);
      markIntentWriteAuthorized(state.storage, pending.intentHash);
      discardPendingIntent(state.storage, pending.intentHash);
      return readPendingIntent(state.storage);
    });
    expect(authorizedIntent).toMatchObject({ status: 'write_authorized' });
    expect(authorizedIntent?.objects.length).toBeGreaterThan(0);
    const persistedIntent = await runInDurableObject(stub, (_instance, state) =>
      [
        ...state.storage.sql.exec<{ data: string }>(
          'SELECT data FROM pending_intent_metadata ORDER BY part_index',
        ),
        ...state.storage.sql.exec<{ data: string }>(
          'SELECT data FROM pending_intent_parts ORDER BY object_index, part_index',
        ),
      ]
        .map(({ data }) => data)
        .join(''),
    );
    expect(persistedIntent).not.toContain(transcriptMarker);
    const before = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(before.objects).toHaveLength(1);

    const retry = await call(stub, await envelope(currentScope, upload));
    expect(retry.response.status).toBe(200);
    expect(retry.body).toEqual(acknowledgement);
    const after = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(after.objects).toHaveLength(2);
    const intentState = await runInDurableObject(
      stub,
      (_instance, state) =>
        [
          ...state.storage.sql.exec<{ status: string }>(
            'SELECT status FROM pending_intents LIMIT 1',
          ),
        ][0]?.status,
    );
    expect(intentState).toBe('committed');
  });

  it('preserves an authorized partial write through a relaunched cap rejection', async () => {
    const currentScope = scope('codex', `authorized-cap-${crypto.randomUUID()}`);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'authorized-partial-record',
      '{"authorized_partial":true}',
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    } satisfies ArchiveUploadRequest;
    const request = await envelope(currentScope, upload);
    const stub = newLedger(currentScope);
    let objectReads = 0;
    const partialWriteBucket = {
      get: async (key: string) => {
        objectReads += 1;
        if (objectReads === 3) throw new Error('partial_r2_read_failure');
        return runtimeEnv.ARCHIVE_STORAGE.get(key);
      },
      put: runtimeEnv.ARCHIVE_STORAGE.put.bind(runtimeEnv.ARCHIVE_STORAGE),
      head: runtimeEnv.ARCHIVE_STORAGE.head.bind(runtimeEnv.ARCHIVE_STORAGE),
    } as unknown as R2Bucket;

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        commitArchiveSession(
          state.storage,
          { ...runtimeEnv, ARCHIVE_STORAGE: partialWriteBucket } as ArchiveApiEnv,
          request,
        ),
      ),
    ).rejects.toThrow('partial_r2_read_failure');

    const pending = await runInDurableObject(stub, (_instance, state) =>
      readPendingIntent(state.storage),
    );
    expect(pending).toMatchObject({ status: 'write_authorized' });
    expect(pending?.objects.length).toBeGreaterThan(1);
    const survivingObject = pending!.objects[0]!;
    const survivingBudgetObject = storageBudgetObject(survivingObject);
    await expect(runtimeEnv.ARCHIVE_STORAGE.head(survivingObject.key)).resolves.not.toBeNull();

    const budgetStub = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    const partialSnapshot = await budgetStub.getStorageBudget({ orgId: currentScope.orgId });
    expect(partialSnapshot).toMatchObject({
      reservedBytes: survivingBudgetObject.bytes,
      committedBytes: 0,
    });
    const filler = {
      objectKey: `budget/${crypto.randomUUID()}`,
      objectClass: 'agent_archive_chunk' as const,
      bytes: ARCHIVE_STORAGE_CAP_BYTES - survivingBudgetObject.bytes - 1,
      expiresAt: null,
    };
    await expect(
      budgetStub.reserveStorage({ orgId: currentScope.orgId, objects: [filler] }),
    ).resolves.toMatchObject({ accepted: true });
    const beforeRejection = await budgetStub.getStorageBudget({ orgId: currentScope.orgId });

    const rejected = await call(newLedger(currentScope), request);
    expect(rejected.response.status).toBe(507);
    expect(rejected.body).toEqual({ error: 'storage_cap_exceeded' });
    expect(
      await runInDurableObject(stub, (_instance, state) => readPendingIntent(state.storage)),
    ).toMatchObject({ status: 'write_authorized' });
    const afterRejection = await budgetStub.getStorageBudget({ orgId: currentScope.orgId });
    expect(afterRejection.reservedBytes).toBe(beforeRejection.reservedBytes);
    expect(afterRejection.reservedBytes).toBe(filler.bytes + survivingBudgetObject.bytes);

    await budgetStub.releaseStorage({ orgId: currentScope.orgId, objects: [filler] });
    const recovered = await call(newLedger(currentScope), request);
    expect(recovered.response.status).toBe(200);
    expect(recovered.body).toMatchObject({ generation: 1 });
    await expect(budgetStub.getStorageBudget({ orgId: currentScope.orgId })).resolves.toMatchObject(
      {
        reservedBytes: 0,
        committedBytes: pending!.objects.reduce(
          (total, object) => total + storageBudgetObject(object).bytes,
          0,
        ),
      },
    );
  });

  it.each(['claude', 'codex'] as const)(
    'recovers a disappeared collector intent before an advancing %s upload',
    async (source) => {
      const currentScope = scope(source, `pending-advance-${crypto.randomUUID()}`);
      const firstRecord = await observation(
        source,
        currentScope.sourceSessionId,
        partFor(source),
        source === 'claude' ? 'r1' : '0',
        '"pending-first"',
      );
      const firstUpload = {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: await checkpoint(source, currentScope.sourceSessionId, partFor(source), [
          firstRecord,
        ]),
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      };
      const { stub } = await seedPendingCommit(currentScope, firstUpload);
      const secondRecord = await observation(
        source,
        currentScope.sourceSessionId,
        partFor(source),
        source === 'claude' ? 'r2' : '1',
        '"pending-second"',
      );
      const secondUpload = {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord, secondRecord],
        checkpoint: await checkpoint(source, currentScope.sourceSessionId, partFor(source), [
          firstRecord,
          secondRecord,
        ]),
        complete_prefix_base64: base64(exactPrefix([firstRecord, secondRecord])),
      };

      const firstAdvance = await call(stub, await envelope(currentScope, secondUpload));
      expect(firstAdvance.response.status).toBe(200);
      expect(firstAdvance.body.appended_records).toBe(1);
      expect(firstAdvance.body.record_count).toBe(2);
      expect(firstAdvance.body.generation).toBe(2);
      const objectsAfterAdvance = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });

      const replay = await call(stub, await envelope(currentScope, secondUpload));
      expect(replay.response.status).toBe(200);
      expect(replay.body).toEqual(firstAdvance.body);
      const objectsAfterReplay = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(objectsAfterReplay.objects.map(({ key }) => key).sort()).toEqual(
        objectsAfterAdvance.objects.map(({ key }) => key).sort(),
      );
      const effects = await ledgerEffects(stub, currentScope);
      expect(effects.storage.ledgerElements).toHaveLength(4);
      expect(
        (effects.storage.pendingIntents ?? []).every((intent) => intent.status === 'committed'),
      ).toBe(true);
    },
  );

  it('recovers a pending intent through the real handler for a second enrolled collector', async () => {
    const currentScope = scope('codex', `handler-pending-recovery-${crypto.randomUUID()}`);
    const identities = [
      { secret: crypto.randomUUID(), collectorId: 'pending-recovery-one' },
      { secret: crypto.randomUUID(), collectorId: 'pending-recovery-two' },
    ];
    const enrolled = await Promise.all(
      identities.map(async (identity) => ({
        ...identity,
        hashedSecret: await sha256Hex(identity.secret),
      })),
    );
    for (const identity of enrolled) {
      await runtimeEnv.COLLECTOR_CREDS.put(
        `collector:${identity.hashedSecret}`,
        JSON.stringify({
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: identity.collectorId,
          expiresAt: Date.now() + 3_600_000,
          status: 'active',
          createdAt: Date.now(),
        }),
      );
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        const body = await request.json<{ collectorId?: unknown; hashedSecret?: unknown }>();
        const identity = enrolled.find(
          (candidate) =>
            candidate.collectorId === body.collectorId &&
            candidate.hashedSecret === body.hashedSecret,
        );
        if (!identity) return Response.json({ allowed: false, reason: 'not_enrolled' });
        return Response.json({
          allowed: true,
          enrollmentId: `enrollment-${identity.collectorId}`,
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: identity.collectorId,
          collectorCredentialId: identity.hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const handlerEnv = {
      COLLECTOR_CREDS: runtimeEnv.COLLECTOR_CREDS,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
      ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE,
      ARCHIVE_SESSION_LEDGER: runtimeEnv.ARCHIVE_SESSION_LEDGER,
      STORAGE_BUDGET: runtimeEnv.STORAGE_BUDGET,
      ARCHIVE_KEY_VERSION: String(KEY_VERSION),
      ARCHIVE_KEY_WRAPPING_SECRET: WRAPPING_SECRET,
    } as unknown as ArchiveApiEnv;
    const firstRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      '0',
      '"handler-pending-first"',
    );
    const firstUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [firstRecord],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [firstRecord],
      ),
      complete_prefix_base64: base64(exactPrefix([firstRecord])),
    };
    await seedPendingCommit(currentScope, firstUpload);
    const secondRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      '1',
      '"handler-pending-second"',
    );
    const advancingUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [firstRecord, secondRecord],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [firstRecord, secondRecord],
      ),
      complete_prefix_base64: base64(exactPrefix([firstRecord, secondRecord])),
    };
    const send = async (secret: string) => {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': secret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(advancingUpload),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      return { response, body: await response.json<Record<string, unknown>>() };
    };

    try {
      const result = await send(enrolled[1]!.secret);
      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({ record_count: 2, generation: 2 });
      const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(listed.objects.length).toBeGreaterThan(2);
      for (const object of listed.objects) {
        const stored = await runtimeEnv.ARCHIVE_STORAGE.get(object.key);
        if (!stored) throw new Error('archive object missing');
        const storedText = await stored.text();
        expect(storedText).not.toContain(firstRecord.payload);
        expect(storedText).not.toContain(secondRecord.payload);
      }
      const replay = await send(enrolled[0]!.secret);
      expect(replay.response.status).toBe(200);
      expect(replay.body).toEqual(result.body);
      const replayObjects = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
      });
      expect(replayObjects.objects.map(({ key }) => key).sort()).toEqual(
        listed.objects.map(({ key }) => key).sort(),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('rejects a pending intent whose stored ciphertext no longer matches the plan', async () => {
    const currentScope = scope('codex', `pending-tamper-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"pending-tamper"',
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const { stub } = await seedPendingCommit(currentScope, upload);
    const pendingBody = await runInDurableObject(
      stub,
      (_instance, state) =>
        [
          ...state.storage.sql.exec<{ data: string }>(
            'SELECT data FROM pending_intent_parts WHERE object_index = 0 AND part_index = 0',
          ),
        ][0]?.data,
    );
    if (!pendingBody) throw new Error('pending body missing');
    const tampered = JSON.parse(pendingBody) as { ciphertext: string };
    tampered.ciphertext = `${tampered.ciphertext.slice(0, -2)}AA`;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE pending_intent_parts SET data = ? WHERE object_index = 0 AND part_index = 0',
        JSON.stringify(tampered),
      );
    });

    const retry = await call(stub, await envelope(currentScope, upload));
    expect(retry.response.status).toBe(409);
    expect(retry.body.error).toBe('pending_object_verification_failed');
    const listed = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(listed.objects).toHaveLength(1);
    const intentState = await runInDurableObject(stub, (_instance, state) => ({
      ledgerElements: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_elements',
        ),
      ][0]?.count,
      status: [
        ...state.storage.sql.exec<{ status: string }>('SELECT status FROM pending_intents LIMIT 1'),
      ][0]?.status,
    }));
    expect(intentState).toEqual({ ledgerElements: 0, status: 'building' });
  });

  it('rejects corrupted pending intent metadata before recovery effects', async () => {
    const currentScope = scope('codex', `pending-metadata-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"pending-metadata"',
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const { stub } = await seedPendingCommit(currentScope, upload);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DELETE FROM pending_intent_metadata');
      state.storage.sql.exec(
        'INSERT INTO pending_intent_metadata (intent_hash, part_index, data) VALUES (?, ?, ?)',
        'unknown',
        0,
        '{',
      );
    });

    const rejected = await call(stub, await envelope(currentScope, upload));
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toBe('pending_intent_corrupt');
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      ledgerState: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_state',
        ),
      ][0]?.count,
      ledgerElements: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_elements',
        ),
      ][0]?.count,
    }));
    expect(state).toEqual({ ledgerState: 0, ledgerElements: 0 });
    const objects = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(objects.objects).toHaveLength(1);
  });

  it('reads one requested Claude checkpoint part without scanning the part table', async () => {
    const currentScope = scope('claude', `targeted-scan-${crypto.randomUUID()}`);
    const targetPart = `claude:part:sha256:${'a'.repeat(64)}`;
    const targetRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      targetPart,
      'target-record',
      '{"target":true}',
    );
    const targetCheckpoint = await checkpoint('claude', currentScope.sourceSessionId, targetPart, [
      targetRecord,
    ]);
    const stub = newLedger(currentScope);
    const result = await runInDurableObject(stub, (_instance, durableState) => {
      for (let index = 0; index < 256; index++) {
        const partId = `claude:part:sha256:${String(index).padStart(64, '0')}`;
        durableState.storage.sql.exec(
          'INSERT INTO ledger_scans (part_id, data) VALUES (?, ?) ',
          partId,
          JSON.stringify({
            checkpoint: { ...targetCheckpoint, source_transcript_part_id: partId },
          }),
        );
      }
      durableState.storage.sql.exec(
        'INSERT INTO ledger_scans (part_id, data) VALUES (?, ?)',
        targetPart,
        JSON.stringify({ checkpoint: targetCheckpoint }),
      );
      const queries: string[] = [];
      const sql = new Proxy(durableState.storage.sql, {
        get(target, property, receiver) {
          if (property === 'exec') {
            const exec = target.exec.bind(target);
            return (query: string, ...args: unknown[]) => {
              queries.push(query);
              if (
                query.toUpperCase().includes('FROM LEDGER_SCANS') &&
                (query.toUpperCase().includes('ORDER BY') || args[0] !== targetPart)
              ) {
                throw new Error('unbounded ledger_scans read');
              }
              return exec(query, ...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const storage: DurableObjectStorage = new Proxy(durableState.storage, {
        get(target, property, receiver) {
          if (property === 'sql') return sql;
          return Reflect.get(target, property, receiver);
        },
      });
      const snapshot = readLedgerSnapshot(storage);
      const scan = readLedgerScan(storage, targetPart);
      return { queries, snapshot, scan };
    });
    expect(result.snapshot).not.toHaveProperty('scans');
    expect(result.scan?.checkpoint).toEqual(targetCheckpoint);
    expect(
      result.queries.filter((query) => query.toUpperCase().includes('FROM LEDGER_SCANS')),
    ).toEqual(['SELECT data FROM ledger_scans WHERE part_id = ?']);
  });

  it('keeps retained-ledger reads fixed for retries and one-record appends', async () => {
    const currentScope = scope('codex', `fixed-ledger-reads-${crypto.randomUUID()}`);
    const records = await Promise.all(
      Array.from({ length: 2_048 }, (_, index) =>
        observation(
          'codex',
          currentScope.sourceSessionId,
          partFor('codex'),
          `codex:part:primary:codex:line:${index}`,
          JSON.stringify({ index }),
        ),
      ),
    );
    const initialPrefix = exactPrefix(records);
    const initialCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      records,
    );
    const initialUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: records,
      checkpoint: initialCheckpoint,
      complete_prefix_base64: base64(initialPrefix),
    } satisfies ArchiveUploadRequest;
    const stub = newLedger(currentScope);
    const initial = await call(stub, await envelope(currentScope, initialUpload));
    expect(initial.response.status).toBe(200);

    const commitWithReadSpy = async (value: Record<string, unknown>) =>
      runInDurableObject(stub, async (_instance, durableState) => {
        const retainedLedgerReads: string[] = [];
        const sql = new Proxy(durableState.storage.sql, {
          get(target, property, receiver) {
            if (property === 'exec') {
              const exec = target.exec.bind(target);
              return (query: string, ...args: unknown[]) => {
                if (query.toUpperCase().includes('FROM LEDGER_ELEMENTS')) {
                  retainedLedgerReads.push(query);
                }
                return exec(query, ...args);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
        const storage = new Proxy(durableState.storage, {
          get(target, property, receiver) {
            if (property === 'sql') return sql;
            if (property === 'transactionSync') return target.transactionSync.bind(target);
            return Reflect.get(target, property, receiver);
          },
        });
        const acknowledgement = await commitArchiveSession(
          storage,
          runtimeEnv as unknown as ArchiveApiEnv,
          value,
        );
        return { acknowledgement, retainedLedgerReads };
      });

    const exactRetry = await commitWithReadSpy(await envelope(currentScope, initialUpload));
    expect(exactRetry.acknowledgement).toEqual(initial.body);
    expect(exactRetry.retainedLedgerReads).toEqual([]);

    const appendRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      `codex:part:primary:codex:line:${records.length}`,
      JSON.stringify({ append: true }),
    );
    const appendedBytes = new TextEncoder().encode(`${appendRecord.payload}\n`);
    const completePrefix = new Uint8Array(initialPrefix.length + appendedBytes.length);
    completePrefix.set(initialPrefix);
    completePrefix.set(appendedBytes, initialPrefix.length);
    const appendCheckpoint = {
      ...initialCheckpoint,
      record_count: initialCheckpoint.record_count + 1,
      last_source_record_identity: appendRecord.source_record_identity,
      last_complete_byte_offset:
        initialCheckpoint.last_complete_byte_offset + appendedBytes.byteLength,
      observed_file_size: initialCheckpoint.observed_file_size + appendedBytes.byteLength,
      complete_prefix_sha256: await digest(completePrefix),
      prefix_chain_sha256: await prefixChainHash(
        initialCheckpoint.prefix_chain_sha256,
        appendedBytes,
      ),
    };
    const appendUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [appendRecord],
      checkpoint: appendCheckpoint,
      prior_checkpoint: initialCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: initialCheckpoint.prefix_chain_sha256,
        appended_prefix_base64: base64(appendedBytes),
      },
    } satisfies ArchiveUploadRequest;
    const appendResult = await commitWithReadSpy(await envelope(currentScope, appendUpload));
    expect(appendResult.acknowledgement.appended_records).toBe(1);
    expect(appendResult.retainedLedgerReads).toEqual([]);
  });

  it('keeps Claude checkpoint parts independent across multiple commits', async () => {
    const currentScope = scope('claude', `multi-part-${crypto.randomUUID()}`);
    const parentPart = 'claude:part:parent';
    const subagentPart = `claude:part:sha256:${'b'.repeat(64)}`;
    const parentRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      parentPart,
      'parent-record',
      '{"part":"parent"}',
    );
    const subagentRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      subagentPart,
      'subagent-record-1',
      '{"part":"subagent","index":1}',
    );
    const subagentAppend = await observation(
      'claude',
      currentScope.sourceSessionId,
      subagentPart,
      'subagent-record-2',
      '{"part":"subagent","index":2}',
    );
    const stub = newLedger(currentScope);
    const parentCheckpoint = await checkpoint('claude', currentScope.sourceSessionId, parentPart, [
      parentRecord,
    ]);
    const subagentCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      subagentPart,
      [subagentRecord],
    );
    const parentResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [parentRecord],
        checkpoint: parentCheckpoint,
        complete_prefix_base64: base64(exactPrefix([parentRecord])),
      }),
    );
    const subagentResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [subagentRecord],
        checkpoint: subagentCheckpoint,
        complete_prefix_base64: base64(exactPrefix([subagentRecord])),
      }),
    );
    expect(parentResult.response.status).toBe(200);
    expect(subagentResult.response.status).toBe(200);

    const subagentNextCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      subagentPart,
      [subagentRecord, subagentAppend],
    );
    const subagentAppendResult = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [subagentRecord, subagentAppend],
        checkpoint: subagentNextCheckpoint,
        prior_checkpoint: subagentCheckpoint,
        complete_prefix_base64: base64(exactPrefix([subagentRecord, subagentAppend])),
      }),
    );
    expect(subagentAppendResult.response.status).toBe(200);
    expect(subagentAppendResult.body).toMatchObject({
      appended_records: 1,
      record_count: 3,
    });

    const parentRescanCheckpoint = {
      ...parentCheckpoint,
      observed_file_size: parentCheckpoint.observed_file_size + 1,
    };
    const parentRescan = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [parentRecord],
        checkpoint: parentRescanCheckpoint,
        complete_prefix_base64: base64(exactPrefix([parentRecord])),
      }),
    );
    expect(parentRescan.response.status).toBe(200);
    expect(parentRescan.body).toMatchObject({ record_count: 3, appended_records: 0 });
  });

  it('matches the frozen Rust chain hash vectors', async () => {
    const raw = '{ "uuid": "r1", "value": 1 }';
    const record = await observation(
      'claude',
      'session-1',
      'claude:part:parent',
      'claude:part:parent:claude:id:r1:0',
      raw,
      10,
    );
    const recordHash = await recordChainHash(`sha256:${'00'.repeat(32)}`, 0, record);
    expect(recordHash).toBe(
      'sha256:01893501e31104a203f048c833ba70416de97b27c24f6b5bb5f25a2960061a9f',
    );
    const scanCheckpoint = await checkpoint(
      'claude',
      'session-1',
      'claude:part:parent',
      [record],
      undefined,
      10,
    );
    const checkpointHash = await checkpointChainHash(recordHash, 1, scanCheckpoint);
    expect(checkpointHash).toBe(
      'sha256:0e10b5049417b7d2bce25557c32e44cc9f3f321b99adc15e5782e78125e2ea11',
    );
  });

  it('deduplicates unchanged scans and retains changed same-identity versions', async () => {
    const currentScope = scope('claude', `versions-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"one"',
    );
    const firstCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const first = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    const unchanged = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(unchanged.body.duplicate).toBe(false);
    expect(unchanged.body.generation).toBe(first.body.generation);

    const changedRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"one-replaced"',
    );
    const changedCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord, changedRecord],
    );
    const changed = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord, changedRecord],
        checkpoint: changedCheckpoint,
        prior_checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord, changedRecord])),
      }),
    );
    expect(changed.response.status).toBe(200);
    expect(changed.body.appended_records).toBe(1);
    expect(changed.body.record_count).toBe(2);
    expect(changed.body.generation).toBe(2);
  });

  it('accepts a provable extension from a second collector without prior acknowledgement', async () => {
    const currentScope = scope('codex', `multi-collector-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      'r1',
      '"one"',
    );
    const secondRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      'r2',
      '"two"',
    );
    const firstCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const first = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(first.response.status).toBe(200);

    const unchangedDelta = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [],
        checkpoint: {
          ...firstCheckpoint,
          observed_file_size: firstCheckpoint.observed_file_size + 1,
        },
        prior_checkpoint: firstCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
          appended_prefix_base64: '',
        },
      }),
    );
    expect(unchangedDelta.response.status).toBe(200);
    expect(unchangedDelta.body.appended_records).toBe(0);
    expect(unchangedDelta.body.appended_checkpoint).toBe(false);

    const extensionCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord, secondRecord],
    );
    const extension = await call(
      newLedger(currentScope),
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord, secondRecord],
        checkpoint: extensionCheckpoint,
        complete_prefix_base64: base64(
          new TextEncoder().encode(`${firstRecord.payload}\n${secondRecord.payload}\n`),
        ),
      }),
    );
    expect(extension.response.status).toBe(200);
    expect(extension.body.appended_records).toBe(1);
    expect(extension.body.record_count).toBe(2);
    expect(extension.body.generation).toBe(2);
  });

  it('accepts an incremental batch with a bounded append proof', async () => {
    const currentScope = scope('claude', `incremental-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"one"',
    );
    const secondRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r2',
      '"two"',
    );
    const firstCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const first = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(first.response.status).toBe(200);

    const extensionCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord, secondRecord],
    );
    const appendedPrefix = new TextEncoder().encode('"two"\n');
    extensionCheckpoint.prefix_chain_sha256 = await prefixChainHash(
      firstCheckpoint.prefix_chain_sha256,
      appendedPrefix,
    );
    const extension = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [secondRecord],
        checkpoint: extensionCheckpoint,
        prior_checkpoint: firstCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
          appended_prefix_base64: base64(appendedPrefix),
        },
      }),
    );
    expect(extension.response.status).toBe(200);
    expect(extension.body.appended_records).toBe(1);
    expect(extension.body.record_count).toBe(2);
    expect(extension.body.generation).toBe(2);
  });

  it('rejects an incremental checkpoint without bounded append proof', async () => {
    const currentScope = scope('claude', `unproved-delta-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '"one"',
    );
    const secondRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r2',
      '"two"',
    );
    const firstCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(initial.response.status).toBe(200);

    const rejected = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [secondRecord],
        checkpoint: await checkpoint('claude', currentScope.sourceSessionId, partFor('claude'), [
          firstRecord,
          secondRecord,
        ]),
        prior_checkpoint: firstCheckpoint,
      }),
    );
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toBe('checkpoint_prefix_unverifiable');
    const state = await runInDurableObject(
      stub,
      (_instance, durableState) =>
        [
          ...durableState.storage.sql.exec<{ data: string }>(
            'SELECT data FROM ledger_state WHERE id = 1',
          ),
        ][0]?.data,
    );
    if (!state) throw new Error('ledger state row missing');
    expect((JSON.parse(state) as { generation: number }).generation).toBe(1);
  });

  it('rejects changed or shortened history in a bounded append proof', async () => {
    const currentScope = scope('codex', `bounded-prefix-failure-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      'codex:part:primary:codex:line:0',
      '"first"',
    );
    const secondRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      'codex:part:primary:codex:line:1',
      '"second"',
    );
    const priorCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: priorCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(initial.response.status).toBe(200);

    const appendedPrefix = new TextEncoder().encode('"second"\n');
    const nextCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord, secondRecord],
    );
    nextCheckpoint.prefix_chain_sha256 = await prefixChainHash(
      priorCheckpoint.prefix_chain_sha256,
      appendedPrefix,
    );
    const changedHistory = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [secondRecord],
        checkpoint: nextCheckpoint,
        prior_checkpoint: priorCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: `sha256:${'11'.repeat(32)}`,
          appended_prefix_base64: base64(appendedPrefix),
        },
      }),
    );
    expect(changedHistory.response.status).toBe(409);
    expect(changedHistory.body.error).toBe('historical_prefix_changed');

    const shortenedHistory = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [secondRecord],
        checkpoint: {
          ...nextCheckpoint,
          last_complete_byte_offset: priorCheckpoint.last_complete_byte_offset - 1,
        },
        prior_checkpoint: priorCheckpoint,
        append_proof: {
          prior_prefix_chain_sha256: priorCheckpoint.prefix_chain_sha256,
          appended_prefix_base64: base64(appendedPrefix),
        },
      }),
    );
    expect(shortenedHistory.response.status).toBe(409);
    expect(shortenedHistory.body.error).toBe('checkpoint_regressed');
    const stateRows = await runInDurableObject(stub, (_instance, durableState) => [
      ...durableState.storage.sql.exec<{ data: string }>(
        'SELECT data FROM ledger_state WHERE id = 1',
      ),
    ]);
    expect(
      stateRows[0] ? (JSON.parse(stateRows[0].data) as { generation: number }).generation : 0,
    ).toBe(1);
  });

  it('accepts a bounded append proof from a transcript larger than the HTTP cap', async () => {
    const currentScope = scope('codex', `long-history-${crypto.randomUUID()}`);
    const stub = newLedger(currentScope);
    const batchSize = 100;
    const totalRecords = 2_500;
    const payloads = Array.from({ length: totalRecords }, (_, index) =>
      JSON.stringify({ index, value: 'x'.repeat(3_400) }),
    );
    let historicalPrefix = new Uint8Array();
    let priorCheckpoint: CompletedScanCheckpoint | undefined;
    for (let start = 0; start < payloads.length; start += batchSize) {
      const batchPayloads = payloads.slice(start, start + batchSize);
      const records = await Promise.all(
        batchPayloads.map((payload, index) =>
          observation(
            currentScope.source,
            currentScope.sourceSessionId,
            partFor(currentScope.source),
            `codex:part:primary:codex:line:${start + index}`,
            payload,
          ),
        ),
      );
      const deltaBytes = new TextEncoder().encode(
        batchPayloads.map((payload) => `${payload}\n`).join(''),
      );
      const nextPrefix = new Uint8Array(historicalPrefix.length + deltaBytes.length);
      nextPrefix.set(historicalPrefix);
      nextPrefix.set(deltaBytes, historicalPrefix.length);
      const batchCheckpoint = await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        records,
      );
      const nextCheckpoint = priorCheckpoint
        ? {
            ...batchCheckpoint,
            record_count: start + records.length,
            last_source_record_identity: records.at(-1)!.source_record_identity,
            last_complete_byte_offset: nextPrefix.byteLength,
            observed_file_size: nextPrefix.byteLength,
            complete_prefix_sha256: await digest(nextPrefix),
            prefix_chain_sha256: await prefixChainHash(
              priorCheckpoint.prefix_chain_sha256,
              deltaBytes,
            ),
            first_observed_at: priorCheckpoint.first_observed_at,
          }
        : batchCheckpoint;
      const upload = {
        source_session_id: currentScope.sourceSessionId,
        observations: records,
        checkpoint: nextCheckpoint,
        ...(priorCheckpoint
          ? {
              prior_checkpoint: priorCheckpoint,
              append_proof: {
                prior_prefix_chain_sha256: priorCheckpoint.prefix_chain_sha256,
                appended_prefix_base64: base64(deltaBytes),
              },
            }
          : { complete_prefix_base64: base64(exactPrefix(records)) }),
      } satisfies ArchiveUploadRequest;
      const result = await call(stub, await envelope(currentScope, upload));
      expect(result.response.status).toBe(200);
      historicalPrefix = nextPrefix;
      priorCheckpoint = nextCheckpoint;
    }
    expect(historicalPrefix.byteLength).toBeGreaterThan(MAX_ARCHIVE_UPLOAD_BYTES);

    const appendRecord = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      `codex:part:primary:codex:line:${totalRecords}`,
      '{"append":true}',
    );
    const appendBytes = new TextEncoder().encode(`${appendRecord.payload}\n`);
    const appendPrefix = new Uint8Array(historicalPrefix.length + appendBytes.length);
    appendPrefix.set(historicalPrefix);
    appendPrefix.set(appendBytes, historicalPrefix.length);
    const appendCheckpoint = {
      ...priorCheckpoint!,
      record_count: totalRecords + 1,
      last_source_record_identity: appendRecord.source_record_identity,
      last_complete_byte_offset: priorCheckpoint!.last_complete_byte_offset + appendBytes.length,
      observed_file_size: priorCheckpoint!.observed_file_size + appendBytes.length,
      complete_prefix_sha256: await digest(appendPrefix),
      prefix_chain_sha256: await prefixChainHash(priorCheckpoint!.prefix_chain_sha256, appendBytes),
    };
    const appendUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [appendRecord],
      checkpoint: appendCheckpoint,
      prior_checkpoint: priorCheckpoint,
      append_proof: {
        prior_prefix_chain_sha256: priorCheckpoint!.prefix_chain_sha256,
        appended_prefix_base64: base64(appendBytes),
      },
    } satisfies ArchiveUploadRequest;
    expect(new TextEncoder().encode(JSON.stringify(appendUpload)).byteLength).toBeLessThan(
      MAX_ARCHIVE_UPLOAD_BYTES,
    );
    const collectorSecret = 'long-history-handler-secret';
    const hashedSecret = await sha256Hex(collectorSecret);
    await runtimeEnv.COLLECTOR_CREDS.put(
      `collector:${hashedSecret}`,
      JSON.stringify({
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: 'long-history-handler-collector',
        expiresAt: Date.now() + 3_600_000,
        status: 'active',
        createdAt: Date.now(),
      }),
    );
    const handlerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/archive-api/authorize-write') {
        return Response.json({
          allowed: true,
          enrollmentId: 'long-history-enrollment',
          contributionId: currentScope.contributionId,
          orgId: currentScope.orgId,
          userId: currentScope.userId,
          collectorId: 'long-history-handler-collector',
          collectorCredentialId: hashedSecret,
        });
      }
      if (url.pathname === '/archive-api/key') {
        return Response.json({
          wrappedKey: await archiveKey(currentScope.orgId),
          keyVersion: KEY_VERSION,
        });
      }
      throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    });
    const handlerEnv = {
      ...runtimeEnv,
      CONVEX_SITE_URL: 'https://archive-convex.test',
      ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
    } as unknown as ArchiveApiEnv;
    let appendResult: { response: Response; body: Record<string, unknown> };
    try {
      const executionContext = createExecutionContext();
      const response = await app.fetch(
        new Request('https://archive.test/v1/archive/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trace-Flow-Collector-Secret': collectorSecret,
            'X-Trace-Flow-Archive-Source': currentScope.source,
          },
          body: JSON.stringify(appendUpload),
        }),
        handlerEnv,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
      appendResult = { response, body: await response.json<Record<string, unknown>>() };
    } finally {
      handlerFetch.mockRestore();
    }
    expect(appendResult.response.status).toBe(200);
    expect(appendResult.body.record_count).toBe(totalRecords + 1);

    const rootObject = await runtimeEnv.ARCHIVE_STORAGE.get(
      appendResult.body.manifest_key as string,
    );
    if (!rootObject) throw new Error('paged manifest root missing');
    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const root = JSON.parse(
      new TextDecoder().decode(
        await decryptArchiveObject(JSON.parse(await rootObject.text()), {
          key,
          orgId: currentScope.orgId,
          objectKey: appendResult.body.manifest_key as string,
          objectClass: 'manifest',
          keyVersion: KEY_VERSION,
        }),
      ),
    ) as { pages: { page_key: string; element_count: number }[]; element_count: number };
    expect(root.element_count).toBe(totalRecords + Math.ceil(totalRecords / batchSize) + 2);
    expect(root.pages).toHaveLength(1);
    let pageElementCount = 0;
    const visited = new Set<string>();
    const visitPage = async (pageKey: string): Promise<void> => {
      if (visited.has(pageKey)) return;
      visited.add(pageKey);
      const pageObject = await runtimeEnv.ARCHIVE_STORAGE.get(pageKey);
      if (!pageObject) throw new Error('paged manifest page missing');
      const page = JSON.parse(
        new TextDecoder().decode(
          await decryptArchiveObject(JSON.parse(await pageObject.text()), {
            key,
            orgId: currentScope.orgId,
            objectKey: pageKey,
            objectClass: 'manifest',
            keyVersion: KEY_VERSION,
          }),
        ),
      ) as {
        elements?: { byte_range: { start: number; end: number } }[];
        pages?: { page_key: string }[];
        previous_page_key?: string;
        element_count: number;
      };
      if (page.elements) {
        expect(
          page.elements.every((element) => element.byte_range.end > element.byte_range.start),
        ).toBe(true);
        pageElementCount += page.element_count;
      } else {
        for (const reference of page.pages ?? []) await visitPage(reference.page_key);
        if (page.previous_page_key) await visitPage(page.previous_page_key);
      }
    };
    await visitPage(root.pages[0]!.page_key);
    expect(pageElementCount).toBe(root.element_count);

    const archiveObjects: { key: string; size: number }[] = [];
    let inventoryCursor: string | undefined;
    do {
      const page = await runtimeEnv.ARCHIVE_STORAGE.list({
        prefix: await archiveSessionPrefix(currentScope),
        ...(inventoryCursor === undefined ? {} : { cursor: inventoryCursor }),
      });
      archiveObjects.push(...page.objects.map(({ key, size }) => ({ key, size })));
      inventoryCursor = page.truncated ? page.cursor : undefined;
    } while (inventoryCursor !== undefined);
    const budgetSnapshot = await runtimeEnv.STORAGE_BUDGET.getByName(
      currentScope.orgId,
    ).getStorageBudget({
      orgId: currentScope.orgId,
    });
    expect(budgetSnapshot.committedBytes).toBe(
      archiveObjects.reduce((sum, archiveObject) => sum + archiveObject.size, 0),
    );
    expect(budgetSnapshot.byClass.agent_archive_chunk.committedBytes).toBe(
      archiveObjects
        .filter(({ key }) => key.includes('/chunks/'))
        .reduce((sum, archiveObject) => sum + archiveObject.size, 0),
    );
    expect(budgetSnapshot.byClass.agent_archive_manifest.committedBytes).toBe(
      archiveObjects
        .filter(({ key }) => key.includes('/manifests/'))
        .reduce((sum, archiveObject) => sum + archiveObject.size, 0),
    );
  }, 60_000);

  it('stores a server-owned record wrapper when observations contain conflicting fields', async () => {
    const currentScope = scope('codex', `server-fields-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"record"',
    );
    const poisoned = { ...record, kind: 'checkpoint', chain_hash: 'client-supplied' };
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [poisoned],
      checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([poisoned])),
    };
    const result = await call(newLedger(currentScope), await envelope(currentScope, upload));
    expect(result.response.status).toBe(200);
    const stored = await runInDurableObject(newLedger(currentScope), (_instance, state) => [
      ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_elements'),
    ]);
    const element = JSON.parse(stored[0]!.data) as Record<string, unknown>;
    expect(element.kind).toBe('record');
    expect(element.chain_hash).not.toBe('client-supplied');
    expect(element).not.toHaveProperty('payload');
  });

  it('rejects missing, shortened, and historically changed prefixes without advancing', async () => {
    const currentScope = scope('codex', `prefix-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"zero"',
    );
    const firstCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    const shortened = await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), []);
    const missingProof = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [],
        checkpoint: shortened,
      }),
    );
    expect(missingProof.response.status).toBe(409);
    expect(missingProof.body.error).toBe('missing_historical_prefix_proof');

    const changedRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"changed"',
    );
    const changed = await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
      changedRecord,
    ]);
    const historicalChange = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [changedRecord],
        checkpoint: changed,
        prior_checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([changedRecord])),
      }),
    );
    expect(historicalChange.response.status).toBe(409);
    expect(historicalChange.body.error).toBe('historical_prefix_changed');

    const state = await runInDurableObject(
      stub,
      (_instance, state) =>
        [
          ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
        ][0],
    );
    if (!state) throw new Error('ledger state row missing');
    const stored = JSON.parse(state.data) as { generation: number };
    expect(stored.generation).toBe(initial.body.generation);
  });

  it('rejects a same-position checkpoint after the source file shrinks', async () => {
    const currentScope = scope('codex', `shortened-same-position-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"zero"',
    );
    const originalCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [record],
    );
    const largerFileCheckpoint = {
      ...originalCheckpoint,
      observed_file_size: originalCheckpoint.observed_file_size + 10,
    };
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: largerFileCheckpoint,
        complete_prefix_base64: base64(exactPrefix([record])),
      }),
    );
    expect(initial.response.status).toBe(200);

    const shortened = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: originalCheckpoint,
        complete_prefix_base64: base64(exactPrefix([record])),
      }),
    );
    expect(shortened.response.status).toBe(409);
    expect(shortened.body.error).toBe('checkpoint_regressed');
  });

  it.each(['claude', 'codex'] as const)(
    'rejects an advancing %s delta after the source file shrinks',
    async (source) => {
      const currentScope = scope(source, `shortened-advancing-${crypto.randomUUID()}`);
      const part = partFor(source);
      const firstRecord = await observation(
        source,
        currentScope.sourceSessionId,
        part,
        'r1',
        '"first"',
      );
      const firstCheckpoint = await checkpoint(
        source,
        currentScope.sourceSessionId,
        part,
        [firstRecord],
        100,
      );
      const stub = newLedger(currentScope);
      const initial = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [firstRecord],
          checkpoint: firstCheckpoint,
          complete_prefix_base64: base64(exactPrefix([firstRecord])),
        }),
      );
      expect(initial.response.status).toBe(200);

      const before = await runInDurableObject(stub, (_instance, durableState) => ({
        ledger: [
          ...durableState.storage.sql.exec<{ data: string }>(
            'SELECT data FROM ledger_state WHERE id = 1',
          ),
        ],
        intents: [
          ...durableState.storage.sql.exec<{
            intent_hash: string;
            status: string;
            base_element_count: number;
            base_chain_head: string;
          }>(
            'SELECT intent_hash, status, base_element_count, base_chain_head FROM pending_intents ORDER BY intent_hash',
          ),
        ],
        metadata: [
          ...durableState.storage.sql.exec<{
            intent_hash: string;
            part_index: number;
            data: string;
          }>(
            'SELECT intent_hash, part_index, data FROM pending_intent_metadata ORDER BY intent_hash, part_index',
          ),
        ],
      }));
      const beforeObjects = (
        await runtimeEnv.ARCHIVE_STORAGE.list({
          prefix: await archiveSessionPrefix(currentScope),
        })
      ).objects.map(({ key, size }) => ({ key, size }));

      const appendRecord = await observation(
        source,
        currentScope.sourceSessionId,
        part,
        'r2',
        '"second"',
      );
      const appendedBytes = new TextEncoder().encode(`${appendRecord.payload}\n`);
      const nextUploadCheckpoint = {
        ...(await checkpoint(
          source,
          currentScope.sourceSessionId,
          part,
          [firstRecord, appendRecord],
          exactPrefix([firstRecord]).byteLength + appendedBytes.byteLength,
        )),
        prefix_chain_sha256: await prefixChainHash(
          firstCheckpoint.prefix_chain_sha256,
          appendedBytes,
        ),
      };
      const priorCheckpoint = {
        ...firstCheckpoint,
        observed_file_size: firstCheckpoint.last_complete_byte_offset,
      };
      const shortened = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [appendRecord],
          checkpoint: nextUploadCheckpoint,
          prior_checkpoint: priorCheckpoint,
          append_proof: {
            prior_prefix_chain_sha256: firstCheckpoint.prefix_chain_sha256,
            appended_prefix_base64: base64(appendedBytes),
          },
        }),
      );
      expect(shortened.response.status).toBe(409);
      expect(shortened.body.error).toBe('checkpoint_regressed');

      const after = await runInDurableObject(stub, (_instance, durableState) => ({
        ledger: [
          ...durableState.storage.sql.exec<{ data: string }>(
            'SELECT data FROM ledger_state WHERE id = 1',
          ),
        ],
        intents: [
          ...durableState.storage.sql.exec<{
            intent_hash: string;
            status: string;
            base_element_count: number;
            base_chain_head: string;
          }>(
            'SELECT intent_hash, status, base_element_count, base_chain_head FROM pending_intents ORDER BY intent_hash',
          ),
        ],
        metadata: [
          ...durableState.storage.sql.exec<{
            intent_hash: string;
            part_index: number;
            data: string;
          }>(
            'SELECT intent_hash, part_index, data FROM pending_intent_metadata ORDER BY intent_hash, part_index',
          ),
        ],
      }));
      const afterObjects = (
        await runtimeEnv.ARCHIVE_STORAGE.list({
          prefix: await archiveSessionPrefix(currentScope),
        })
      ).objects.map(({ key, size }) => ({ key, size }));
      expect(after).toEqual(before);
      expect(afterObjects).toEqual(beforeObjects);
    },
  );

  it.each(['claude', 'codex'] as const)(
    'rejects an advancing %s full rescan after the source file shrinks',
    async (source) => {
      const currentScope = scope(source, `shortened-full-rescan-${crypto.randomUUID()}`);
      const part = partFor(source);
      const firstRecord = await observation(
        source,
        currentScope.sourceSessionId,
        part,
        'r1',
        '"first"',
      );
      const partialSource = new TextEncoder().encode(
        `${firstRecord.payload}\n${'partial tail '.repeat(12)}`,
      );
      const firstCheckpoint = await checkpoint(
        source,
        currentScope.sourceSessionId,
        part,
        [firstRecord],
        partialSource.byteLength,
      );
      const stub = newLedger(currentScope);
      const initial = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [firstRecord],
          checkpoint: firstCheckpoint,
          complete_prefix_base64: base64(exactPrefix([firstRecord])),
        }),
      );
      expect(initial.response.status).toBe(200);
      const before = await ledgerEffects(stub, currentScope);

      const secondRecord = await observation(
        source,
        currentScope.sourceSessionId,
        part,
        'r2',
        '"second"',
      );
      const fullPrefix = exactPrefix([firstRecord, secondRecord]);
      const fullCheckpoint = await checkpoint(
        source,
        currentScope.sourceSessionId,
        part,
        [firstRecord, secondRecord],
        fullPrefix.byteLength,
      );
      expect(fullCheckpoint.last_complete_byte_offset).toBe(fullPrefix.byteLength);
      expect(fullCheckpoint.last_complete_byte_offset).toBeGreaterThan(
        firstCheckpoint.last_complete_byte_offset,
      );
      expect(fullCheckpoint.observed_file_size).toBeLessThan(firstCheckpoint.observed_file_size);

      const rejected = await call(
        stub,
        await envelope(currentScope, {
          source_session_id: currentScope.sourceSessionId,
          observations: [firstRecord, secondRecord],
          checkpoint: fullCheckpoint,
          complete_prefix_base64: base64(fullPrefix),
        }),
      );
      expect(rejected.response.status).toBe(409);
      expect(rejected.body).toEqual({ error: 'checkpoint_regressed' });

      const after = await ledgerEffects(stub, currentScope);
      expect(after).toEqual(before);
    },
  );

  it('rejects a historically changed Source prefix without advancing', async () => {
    const currentScope = scope('codex', `historical-${crypto.randomUUID()}`);
    const firstRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"zero"',
    );
    const firstCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      [firstRecord],
    );
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [firstRecord],
        checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([firstRecord])),
      }),
    );
    expect(initial.response.status).toBe(200);

    const changedRecord = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '"changed"',
    );
    const changed = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [changedRecord],
        checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
          changedRecord,
        ]),
        prior_checkpoint: firstCheckpoint,
        complete_prefix_base64: base64(exactPrefix([changedRecord])),
      }),
    );
    expect(changed.response.status).toBe(409);
    expect(changed.body.error).toBe('historical_prefix_changed');
  });

  it.each([
    ['claude', claudeFixture],
    ['codex', codexFixture],
  ] as const)('round-trips the lossless %s source fixture', async (source, fixture) => {
    const currentScope = scope(source, `fixture-${crypto.randomUUID()}`);
    const upload = await fixtureUpload(source, currentScope.sourceSessionId, fixture);
    const result = await call(newLedger(currentScope), await envelope(currentScope, upload));
    expect(result.response.status).toBe(200);

    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const manifestObject = await runtimeEnv.ARCHIVE_STORAGE.get(result.body.manifest_key as string);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await decryptArchiveObject(JSON.parse(await manifestObject!.text()), {
          key,
          orgId: currentScope.orgId,
          objectKey: result.body.manifest_key as string,
          objectClass: 'manifest',
          keyVersion: KEY_VERSION,
        }),
      ),
    ) as { elements: { byte_range: { chunk_id: string; start: number; end: number } }[] };
    const plaintextChunks = new Map<string, Uint8Array>();
    const payload = [] as Uint8Array[];
    for (const element of manifest.elements) {
      const range = element.byte_range;
      let chunk = plaintextChunks.get(range.chunk_id);
      if (!chunk) {
        const chunkKey = `${await archiveSessionPrefix(currentScope)}/chunks/${range.chunk_id}`;
        const chunkObject = await runtimeEnv.ARCHIVE_STORAGE.get(chunkKey);
        const compressed = await decryptArchiveObject(JSON.parse(await chunkObject!.text()), {
          key,
          orgId: currentScope.orgId,
          objectKey: chunkKey,
          objectClass: 'chunk',
          keyVersion: KEY_VERSION,
        });
        chunk = await decompress(compressed);
        plaintextChunks.set(range.chunk_id, chunk);
      }
      const parsed = JSON.parse(
        new TextDecoder().decode(chunk.slice(range.start, range.end - 1)),
      ) as StoredElement;
      if (parsed.kind === 'record') {
        payload.push(payloadBytes(parsed), new Uint8Array([0x0a]));
      }
    }
    const reconstructed = new Uint8Array(payload.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of payload) {
      reconstructed.set(part, offset);
      offset += part.length;
    }
    expect(reconstructed).toEqual(new TextEncoder().encode(fixture));
  });

  it('uses exact source-prefix bytes to reject changed historical whitespace', async () => {
    const currentScope = scope('claude', `prefix-bytes-${crypto.randomUUID()}`);
    const record = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'claude:part:parent:claude:id:r1:0',
      '{"uuid":"r1"}',
    );
    const originalPrefix = new TextEncoder().encode('\n \n{"uuid":"r1"}\n');
    const originalCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [record],
      originalPrefix.byteLength,
    );
    originalCheckpoint.last_complete_byte_offset = originalPrefix.byteLength;
    originalCheckpoint.complete_prefix_sha256 = await digest(originalPrefix);
    originalCheckpoint.prefix_chain_sha256 = await prefixChainHash(undefined, originalPrefix);
    const stub = newLedger(currentScope);
    const initial = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: originalCheckpoint,
        complete_prefix_base64: base64(originalPrefix),
      }),
    );
    expect(initial.response.status).toBe(200);

    const mismatchedRecord = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'claude:part:parent:claude:id:r1:0',
      '{"uuid":"r1","changed":true}',
    );
    const mismatched = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [mismatchedRecord],
        checkpoint: originalCheckpoint,
        complete_prefix_base64: base64(originalPrefix),
      }),
    );
    expect(mismatched.response.status).toBe(400);
    expect(mismatched.body.error).toBe('checkpoint_prefix_unverifiable');

    const changedPrefix = new TextEncoder().encode('\n\t\n{"uuid":"r1"}\n');
    const changedCheckpoint = {
      ...originalCheckpoint,
      last_complete_byte_offset: changedPrefix.byteLength,
      complete_prefix_sha256: await digest(changedPrefix),
      prefix_chain_sha256: await prefixChainHash(undefined, changedPrefix),
    };
    const rejected = await call(
      stub,
      await envelope(currentScope, {
        source_session_id: currentScope.sourceSessionId,
        observations: [record],
        checkpoint: changedCheckpoint,
        prior_checkpoint: originalCheckpoint,
        complete_prefix_base64: base64(changedPrefix),
      }),
    );
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toBe('historical_prefix_changed');
  });

  it('validates large binary base64 payloads and rejects noncanonical UTF-8 base64', async () => {
    const currentScope = scope('codex', `encoding-${crypto.randomUUID()}`);
    const binary = new Uint8Array(MAX_CHUNK_BYTES);
    binary[0] = 0xff;
    binary[1] = 0;
    binary[binary.length - 1] = 0xfe;
    const binaryRecord = {
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      chain_hash_version: CHAIN_HASH_VERSION,
      source: 'codex' as const,
      source_session_id: currentScope.sourceSessionId,
      source_transcript_part_id: partFor('codex'),
      source_record_identity: 'codex:part:primary:codex:line:0',
      observed_at: 1,
      payload_encoding: 'base64' as const,
      payload: base64(binary),
      content_sha256: await digest(binary),
    };
    await expect(
      validateObservation(binaryRecord, {
        source: 'codex',
        sourceSessionId: currentScope.sourceSessionId,
      }),
    ).resolves.toEqual(binaryRecord);

    const utf8 = new TextEncoder().encode('valid utf8');
    await expect(
      validateObservation(
        { ...binaryRecord, payload: base64(utf8), content_sha256: await digest(utf8) },
        { source: 'codex', sourceSessionId: currentScope.sourceSessionId },
      ),
    ).rejects.toMatchObject({ errorClass: 'noncanonical_payload_encoding' });
  });

  it('writes encrypted lossless chunks and manifests with exact byte ranges', async () => {
    const currentScope = scope('claude', `manifest-${crypto.randomUUID()}`);
    const first = await observation(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      'r1',
      '{"marker":"PLAINTEXT_MARKER"}',
    );
    const firstCheckpoint = await checkpoint(
      'claude',
      currentScope.sourceSessionId,
      partFor('claude'),
      [first],
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [first],
      checkpoint: firstCheckpoint,
      complete_prefix_base64: base64(exactPrefix([first])),
    };
    const stub = newLedger(currentScope);
    const result = await call(stub, await envelope(currentScope, upload));
    expect(result.response.status).toBe(200);
    const ledgerRows = await runInDurableObject(stub, (_instance, state) => ({
      metadata: [
        ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
      ][0]?.data,
      elements: [
        ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_elements'),
      ].map((row) => row.data),
    }));
    expect(JSON.stringify(ledgerRows)).not.toContain('PLAINTEXT_MARKER');
    const manifestObject = await runtimeEnv.ARCHIVE_STORAGE.get(result.body.manifest_key as string);
    expect(manifestObject).not.toBeNull();
    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const manifestBytes = await decryptArchiveObject(JSON.parse(await manifestObject!.text()), {
      key,
      orgId: currentScope.orgId,
      objectKey: result.body.manifest_key as string,
      objectClass: 'manifest',
      keyVersion: KEY_VERSION,
    });
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      elements: { byte_range: { chunk_id: string; start: number; end: number } }[];
    };
    expect(manifest.elements).toHaveLength(2);
    const chunkKey = result.body.chunk_keys as string[];
    const chunkObject = await runtimeEnv.ARCHIVE_STORAGE.get(chunkKey[0]!);
    const compressed = await decryptArchiveObject(JSON.parse(await chunkObject!.text()), {
      key,
      orgId: currentScope.orgId,
      objectKey: chunkKey[0]!,
      objectClass: 'chunk',
      keyVersion: KEY_VERSION,
    });
    const plain = await decompress(compressed);
    for (const element of manifest.elements) {
      expect(element.byte_range.chunk_id).toBe(chunkKey[0]!.split('/').at(-1));
      expect(element.byte_range.end).toBeGreaterThan(element.byte_range.start);
      expect(element.byte_range.end).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(plain.slice(element.byte_range.start, element.byte_range.end).byteLength).toBe(
        element.byte_range.end - element.byte_range.start,
      );
    }
    const rawChunk = await runtimeEnv.ARCHIVE_STORAGE.get(chunkKey[0]!);
    const rawManifest = await runtimeEnv.ARCHIVE_STORAGE.get(result.body.manifest_key as string);
    expect(await rawChunk!.text()).not.toContain('PLAINTEXT_MARKER');
    expect(await rawManifest!.text()).not.toContain('PLAINTEXT_MARKER');
  });

  it('rejects an immutable collision without acknowledging the upload', async () => {
    const currentScope = scope('codex', `verify-${crypto.randomUUID()}`);
    const record = await observation(
      'codex',
      currentScope.sourceSessionId,
      partFor('codex'),
      '0',
      '{"value":"verify"}',
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint('codex', currentScope.sourceSessionId, partFor('codex'), [
        record,
      ]),
      complete_prefix_base64: base64(exactPrefix([record])),
    };
    const stub = newLedger(currentScope);
    const first = await call(stub, await envelope(currentScope, upload));
    const chunkKey = (first.body.chunk_keys as string[])[0]!;
    await runtimeEnv.ARCHIVE_STORAGE.put(chunkKey, 'corrupt');
    await expect(
      verifyOrPutImmutableObject(runtimeEnv.ARCHIVE_STORAGE, {
        key: chunkKey,
        body: 'different',
        objectClass: 'chunk',
      }),
    ).rejects.toMatchObject({ errorClass: 'immutable_object_collision' });
  });

  it('rejects a storage-cap upload before the first R2 mutation and blocks archive status', async () => {
    const currentScope = scope('codex', `storage-cap-${crypto.randomUUID()}`);
    const budgetStub = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    const filler = {
      objectKey: `budget/filler-${crypto.randomUUID()}`,
      objectClass: 'agent_archive_chunk' as const,
      bytes: ARCHIVE_STORAGE_CAP_BYTES - 1,
      expiresAt: null,
    };
    await budgetStub.reserveStorage({ orgId: currentScope.orgId, objects: [filler] });
    await budgetStub.commitStorage({ orgId: currentScope.orgId, objects: [filler] });
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'storage-cap-record',
      '{"storage_cap":true}',
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    } satisfies ArchiveUploadRequest;
    const stub = newLedger(currentScope);
    const result = await call(stub, await envelope(currentScope, upload));
    expect(result.response.status).toBe(507);
    expect(result.body).toEqual({ error: 'storage_cap_exceeded' });
    const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(currentScope),
    });
    expect(stored.objects).toHaveLength(0);
    const ledgerState = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ data: string }>('SELECT data FROM ledger_state WHERE id = 1'),
    ]);
    expect(ledgerState).toHaveLength(0);
    const pendingIntents = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ status: string }>('SELECT status FROM pending_intents'),
    ]);
    expect(pendingIntents).toHaveLength(0);

    __resetPolicyCache();
    const collectorSecret = 'archive-cap-fact-ingest-secret';
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
        return new Response(
          JSON.stringify({
            minDesktopVersion: '1.0.0',
            minParserVersion: '1.0.0',
            denylistedVersions: [],
            updatedAt: Date.now(),
          }),
          { status: 200 },
        );
      }
      if (
        request.method === 'POST' &&
        url.origin === 'https://agent-convex.test' &&
        url.pathname === '/agent-ingest/claim-sessions'
      ) {
        const body = await request.json();
        if (
          typeof body !== 'object' ||
          body === null ||
          !('sessionPks' in body) ||
          !Array.isArray(body.sessionPks) ||
          !body.sessionPks.every((value): value is string => typeof value === 'string')
        ) {
          throw new Error('claim request malformed');
        }
        return new Response(
          JSON.stringify({
            results: body.sessionPks.map((sessionPk) => ({
              sessionPk,
              status: 'claimed',
              ownerUserId: currentScope.userId,
            })),
          }),
          { status: 200 },
        );
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
    const outbox = await runInDurableObject(budgetStub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload: string }>(
        'SELECT payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(JSON.parse(outbox[0]!.payload)).toMatchObject({
      orgId: currentScope.orgId,
      storedBytes: ARCHIVE_STORAGE_CAP_BYTES - 1,
      lifecycle: 'blocked',
    });
  });

  it('retains a durable intent when the storage reservation result is ambiguous', async () => {
    const currentScope = scope('codex', `storage-reservation-${crypto.randomUUID()}`);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'storage-reservation-record',
      '{"storage_reservation":true}',
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    } satisfies ArchiveUploadRequest;
    const request = await envelope(currentScope, upload);
    const stub = newLedger(currentScope);
    const ambiguousEnv = {
      ...runtimeEnv,
      STORAGE_BUDGET: {
        getByName: () => ({
          reserveStorage: async () => {
            throw new Error('storage_reservation_result_ambiguous');
          },
        }),
      },
    } as unknown as ArchiveApiEnv;

    const failure = await runInDurableObject(stub, async (_instance, state) => {
      try {
        await commitArchiveSession(state.storage, ambiguousEnv, request);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(failure).toBe('storage_reservation_result_ambiguous');
    const pending = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM pending_intents WHERE status IN ('building', 'ready', 'write_authorized')",
      ),
    ]);
    expect(pending).toEqual([{ status: 'ready' }]);
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) }),
    ).toMatchObject({ objects: [] });

    const recovered = await call(stub, request);
    expect(recovered.response.status).toBe(200);
    expect(recovered.body).toMatchObject({ generation: 1 });
  });

  it('removes a definitely unwritten intent after a relaunched reservation is capped', async () => {
    const currentScope = scope('codex', `pre-reservation-cap-${crypto.randomUUID()}`);
    const randomPayload = new Uint8Array(12_000);
    crypto.getRandomValues(randomPayload);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'large-unwritten-record',
      JSON.stringify({ payload: base64(randomPayload) }),
    );
    const upload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [record],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [record],
      ),
      complete_prefix_base64: base64(exactPrefix([record])),
    } satisfies ArchiveUploadRequest;
    const request = await envelope(currentScope, upload);
    const stub = newLedger(currentScope);
    const abortBeforeReservation = {
      ...runtimeEnv,
      STORAGE_BUDGET: {
        getByName: () => ({
          reserveStorage: async () => {
            throw new Error('abort_before_storage_reservation');
          },
        }),
      },
    } as unknown as ArchiveApiEnv;

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        commitArchiveSession(state.storage, abortBeforeReservation, request),
      ),
    ).rejects.toThrow('abort_before_storage_reservation');
    const persisted = await runInDurableObject(stub, (_instance, state) => {
      const pending = readPendingIntent(state.storage);
      return {
        status: pending?.status,
        bytes: pending?.objects.reduce(
          (total, object) => total + new TextEncoder().encode(object.body).byteLength,
          0,
        ),
      };
    });
    expect(persisted.status).toBe('ready');
    expect(persisted.bytes).toBeGreaterThan(5_000);
    expect(
      await runtimeEnv.ARCHIVE_STORAGE.list({ prefix: await archiveSessionPrefix(currentScope) }),
    ).toMatchObject({ objects: [] });

    const budgetStub = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    const filler = {
      objectKey: `budget/${crypto.randomUUID()}`,
      objectClass: 'agent_archive_chunk' as const,
      bytes: ARCHIVE_STORAGE_CAP_BYTES - 5_000,
      expiresAt: null,
    };
    await expect(
      budgetStub.reserveStorage({ orgId: currentScope.orgId, objects: [filler] }),
    ).resolves.toMatchObject({ accepted: true });
    await budgetStub.commitStorage({ orgId: currentScope.orgId, objects: [filler] });

    const rejected = await call(newLedger(currentScope), request);
    expect(rejected.response.status).toBe(507);
    expect(rejected.body).toEqual({ error: 'storage_cap_exceeded' });
    expect(
      await runInDurableObject(stub, (_instance, state) => readPendingIntent(state.storage)),
    ).toBeNull();
    await expect(budgetStub.getStorageBudget({ orgId: currentScope.orgId })).resolves.toMatchObject(
      {
        reservedBytes: 0,
        committedBytes: ARCHIVE_STORAGE_CAP_BYTES - 5_000,
        availableBytes: 5_000,
      },
    );

    const replacement = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'small-replacement-record',
      '{}',
    );
    const replacementUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [replacement],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [replacement],
      ),
      complete_prefix_base64: base64(exactPrefix([replacement])),
    } satisfies ArchiveUploadRequest;
    const replacementResult = await call(
      newLedger(currentScope),
      await envelope(currentScope, replacementUpload),
    );
    expect(replacementResult.response.status).toBe(200);
    expect(replacementResult.body).toMatchObject({ generation: 1 });
  });

  it('holds the one-and-a-half MiB uncompressed chunk boundary', async () => {
    const currentScope = scope('claude', `boundary-${crypto.randomUUID()}`);
    const base: StoredRecord = {
      kind: 'record',
      archive_format_version: 1,
      chain_hash_version: 1,
      source: 'claude',
      source_session_id: currentScope.sourceSessionId,
      source_transcript_part_id: partFor('claude'),
      source_record_identity: 'r1',
      observed_at: 1,
      payload_encoding: 'utf8',
      payload: '',
      content_sha256: `sha256:${'11'.repeat(32)}`,
      chain_sequence: 0,
      previous_chain_hash: `sha256:${'00'.repeat(32)}`,
      chain_hash: `sha256:${'22'.repeat(32)}`,
    };
    let low = 0;
    let high = MAX_CHUNK_BYTES;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = { ...base, payload: 'x'.repeat(mid) };
      if (
        new TextEncoder().encode(`${canonicalElement(candidate)}\n`).byteLength <= MAX_CHUNK_BYTES
      )
        low = mid;
      else high = mid - 1;
    }
    const exact = { ...base, payload: 'x'.repeat(low) };
    expect(new TextEncoder().encode(`${canonicalElement(exact)}\n`).byteLength).toBe(
      MAX_CHUNK_BYTES,
    );
    const wrapped = await archiveKey(currentScope.orgId);
    const key = await unwrapArchiveEncryptionKey(JSON.parse(wrapped), {
      orgId: currentScope.orgId,
      keyVersion: KEY_VERSION,
      wrappingSecretBase64: WRAPPING_SECRET,
    });
    const plan = await packNewElements(currentScope, [exact], [exact], {}, 1, key, KEY_VERSION);
    expect(plan.chunks[0]!.plainBytes.byteLength).toBe(MAX_CHUNK_BYTES);
    await expect(
      packNewElements(
        currentScope,
        [
          (({ payload: _payload, ...metadata }) => metadata)({
            ...exact,
            payload: 'x'.repeat(low + 1),
          }),
        ],
        [{ ...exact, payload: 'x'.repeat(low + 1) }],
        {},
        1,
        key,
        KEY_VERSION,
      ),
    ).rejects.toThrow('archive_element_exceeds_chunk_limit');
  });

  it('keeps maximum-length scope identifiers inside the R2 key limit', async () => {
    const currentScope: ArchiveScope = {
      orgId: '组织'.repeat(512),
      userId: 'user',
      contributionId: '贡献'.repeat(512),
      source: 'claude',
      sourceSessionId: 'session'.repeat(146),
    };
    const prefix = await archiveSessionPrefix(currentScope);
    const chunkKey = `${prefix}/chunks/${'a'.repeat(64)}`;
    expect(new TextEncoder().encode(chunkKey).byteLength).toBeLessThan(1024);
    expect(prefix).not.toContain(currentScope.orgId);
    expect(prefix).not.toContain(currentScope.contributionId);
    expect(prefix).not.toContain(currentScope.sourceSessionId);
  });
});
