import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  captureCommand,
  formatProcessFailure,
  sensitiveArgumentValues,
} from './archive-api-process-diagnostics';
import {
  ARCHIVE_FORMAT_VERSION,
  CHAIN_HASH_VERSION,
  GENESIS_CHAIN_HASH,
  type ArchiveObservation,
  type ArchiveSource,
  type ArchiveUploadRequest,
  type CompletedScanCheckpoint,
} from '../../apps/archive-api/src/archive-contract';
import { checkpointChainHash, recordChainHash } from '../../apps/archive-api/src/archive-chain';
import { prefixChainHash } from '../../apps/archive-api/src/archive-prefix-validation';
import { exportSessionDirectoryId } from './archive-export-verification';

const repoRoot = resolve(import.meta.dirname, '../..');
const archiveApiRoot = resolve(repoRoot, 'apps/archive-api');
const expectedDeployment = 'hardy-iguana-812';
const expectedArchiveUrl = 'https://trace-flow-archive-api-dev.isaac-a46.workers.dev';
const expectedArchiveBucket = 'trace-flow-agent-archive-dev';

interface SeedResult {
  orgId: string;
  tokenIdentifier: string;
  collectorCredentialId: string;
  idempotencyKey: string;
}

interface EnrollmentResult {
  enrollmentId: string;
  contributionId: string;
  created: boolean;
}

interface MintResult {
  id: string;
  secret: string;
}

interface ArchiveAcknowledgement {
  status: 'acknowledged';
  duplicate: boolean;
  source: ArchiveSource;
  source_session_id: string;
  contribution_id: string;
  appended_records: number;
  appended_checkpoint: boolean;
  record_count: number;
  generation: number;
  chain_head: string;
  manifest_key: string;
  chunk_keys: string[];
  request_sha256?: string;
  source_transcript_part_id?: string;
  captured_byte_offset?: number;
  captured_prefix_sha256?: string;
}

interface ArchiveStatus {
  lifecycle: string;
  capBytes: number;
  storedBytes: number | null;
  lastDurableAcknowledgedAt: number | null;
  integritySessions: { source: ArchiveSource; sourceSessionId: string }[];
}

interface ExportGrantResult {
  grant: string;
  exportId: string;
  archiveUrl: string;
  expiresAt: number;
}

interface ExportSelection {
  version: 1;
  exportId: string;
  orgId: string;
  selectionSha256: string;
  selectionToken: string;
  sessions: {
    manifestKey: string;
    elementCount: number;
    chainHead: string;
    contributionId: string;
    source: ArchiveSource;
    sourceSessionId: string;
  }[];
}

interface CaptureFixture {
  uploads: ArchiveUploadRequest[];
  request_bodies: string[];
  expected_parts: {
    part_id: string;
    payload_encoding: 'utf8' | 'base64';
    payload: string;
    sha256: string;
  }[];
  source_and_spool_removed: true;
}

interface LocalExportManifest {
  selection: ExportSelection;
  sessions: { session_index: number; status: 'pending' | 'verified' | 'failed' }[];
}

interface LocalSessionManifest {
  parts: {
    source_transcript_part_id: string;
    file: string;
    byte_exact: boolean;
    sha256: string;
    byte_length: number;
    observed_source_size?: number;
    source_capture_complete?: boolean;
  }[];
}

class ConvexCommandError extends Error {
  constructor(
    functionName: string,
    readonly expectedAuthorizationFailure: boolean,
    diagnostic: string,
  ) {
    super(`${functionName} failed\n${diagnostic}`);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runConvex<T>(
  deployment: string,
  functionName: string,
  args: Record<string, unknown>,
  tokenIdentifier?: string,
  allowEmptyOutput = false,
): Promise<T> {
  const cli = process.platform === 'win32' ? 'bunx.cmd' : 'bunx';
  const cliArgs = [
    'convex',
    'run',
    '--deployment',
    deployment,
    '--typecheck',
    'disable',
    '--codegen',
    'disable',
  ];
  if (tokenIdentifier) cliArgs.push('--identity', JSON.stringify({ tokenIdentifier }));
  cliArgs.push(functionName, JSON.stringify(args));

  const sensitiveValues = [
    ...(tokenIdentifier ? [tokenIdentifier] : []),
    ...sensitiveArgumentValues(args),
  ];
  const result = await captureCommand(cli, cliArgs, { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new ConvexCommandError(
      functionName,
      result.stderr.includes('Collector Credential not found'),
      formatProcessFailure('Convex command', result, sensitiveValues),
    );
  }
  if (result.stdout.trim().length === 0) {
    if (allowEmptyOutput) return null as T;
    throw new Error(
      `${functionName} returned no output\n${formatProcessFailure(
        'Convex command',
        result,
        sensitiveValues,
      )}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `${functionName} returned invalid JSON\n${formatProcessFailure(
        'Convex command',
        result,
        sensitiveValues,
      )}`,
    );
  }
}

async function runWrangler(
  args: string[],
  expectedOutcome: 'success' | 'missing' = 'success',
  sensitiveValues: string[] = [],
): Promise<void> {
  const cli = process.platform === 'win32' ? 'bunx.cmd' : 'bunx';
  const result = await captureCommand(cli, ['wrangler', ...args], {
    cwd: archiveApiRoot,
    captureStdout: expectedOutcome !== 'missing',
  });
  if (expectedOutcome === 'success' && result.exitCode === 0) return;
  if (
    expectedOutcome === 'missing' &&
    result.exitCode !== 0 &&
    result.stderr.includes('does not exist')
  ) {
    return;
  }
  throw new Error(formatProcessFailure('Wrangler archive cleanup', result, sensitiveValues));
}

function assertArchiveObjectKey(key: string): void {
  assert.match(
    key,
    /^archive\/[a-f0-9]{64}\/contributions\/[a-f0-9]{64}\/sessions\/(?:claude|codex)\/[a-f0-9]{64}\/(?:chunks|manifests)\/[a-f0-9]{64}$/u,
  );
}

async function deleteArchiveObjects(keys: Set<string>): Promise<void> {
  if (keys.size === 0) return;
  await runWrangler([
    'r2',
    'bucket',
    'info',
    expectedArchiveBucket,
    '--jurisdiction',
    'us',
    '--json',
  ]);
  for (const key of keys) {
    assertArchiveObjectKey(key);
    const objectPath = `${expectedArchiveBucket}/${key}`;
    await runWrangler(
      ['r2', 'object', 'delete', objectPath, '--remote', '--jurisdiction', 'us', '--force'],
      'success',
      [objectPath],
    );
    await runWrangler(
      ['r2', 'object', 'get', objectPath, '--remote', '--jurisdiction', 'us', '--pipe'],
      'missing',
      [objectPath],
    );
  }
}

async function expectConvexFailure(
  operation: Promise<unknown>,
  label: string,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (
      error instanceof ConvexCommandError &&
      expectedMessage === 'Collector Credential not found' &&
      error.expectedAuthorizationFailure
    ) {
      return;
    }
    throw new Error(`${label} failed for an unexpected reason`, { cause: error });
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function uploadFixture(source: ArchiveSource, sourceSessionId: string) {
  const part = source === 'claude' ? 'claude:part:parent' : 'codex:part:primary';
  const recordId = crypto.randomUUID();
  const payload =
    source === 'claude'
      ? JSON.stringify({ type: 'assistant', uuid: recordId, message: 'archive smoke' })
      : JSON.stringify({ type: 'response_item', id: recordId, message: 'archive smoke' });
  const prefix = new TextEncoder().encode(`${payload}\n`);
  const observedAt = Date.now();
  const observation: ArchiveObservation = {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
    chain_hash_version: CHAIN_HASH_VERSION,
    source,
    source_session_id: sourceSessionId,
    source_transcript_part_id: part,
    source_record_identity:
      source === 'claude' ? `${part}:claude:id:${recordId}:0` : `${part}:codex:line:0`,
    observed_at: observedAt,
    payload_encoding: 'utf8',
    payload,
    content_sha256: await sha256(new TextEncoder().encode(payload)),
  };
  const checkpoint: CompletedScanCheckpoint = {
    archive_format_version: ARCHIVE_FORMAT_VERSION,
    chain_hash_version: CHAIN_HASH_VERSION,
    source,
    source_session_id: sourceSessionId,
    source_transcript_part_id: part,
    record_count: 1,
    last_source_record_identity: observation.source_record_identity,
    last_complete_byte_offset: prefix.byteLength,
    observed_file_size: prefix.byteLength,
    complete_prefix_sha256: await sha256(prefix),
    prefix_chain_sha256: await prefixChainHash(undefined, prefix),
    first_observed_at: observedAt,
  };
  const upload: ArchiveUploadRequest = {
    source_session_id: sourceSessionId,
    observations: [observation],
    checkpoint,
    complete_prefix_base64: btoa(String.fromCharCode(...prefix)),
  };
  const recordHead = await recordChainHash(GENESIS_CHAIN_HASH, 0, observation);
  const expectedChainHead = await checkpointChainHash(recordHead, 1, checkpoint);
  return { upload, expectedChainHead };
}

async function sendUpload(
  archiveUrl: string,
  credential: string,
  source: ArchiveSource,
  upload: ArchiveUploadRequest,
): Promise<Response> {
  return fetch(`${archiveUrl}/v1/archive/uploads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Flow-Collector-Secret': credential,
      'X-Trace-Flow-Archive-Source': source,
    },
    body: JSON.stringify(upload),
  });
}

async function sendUploadBody(
  archiveUrl: string,
  credential: string,
  source: ArchiveSource,
  body: string,
): Promise<Response> {
  return fetch(`${archiveUrl}/v1/archive/uploads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Flow-Collector-Secret': credential,
      'X-Trace-Flow-Archive-Source': source,
    },
    body,
  });
}

async function waitForCredentialPolicy(archiveUrl: string, credential: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${archiveUrl}/v1/archive/policy`, {
      headers: { 'X-Trace-Flow-Collector-Secret': credential },
    });
    if (response.status === 200) return;
    if (response.status !== 401) {
      throw new Error(`Collector policy warmup failed with status ${response.status}`);
    }
    await sleep(1_000);
  }
  throw new Error('Collector Credential did not reach the Archive API before the timeout');
}

async function waitForCredentialRevocation(archiveUrl: string, credential: string): Promise<void> {
  // The Worker reads KV on every request, but a delete can take 60 seconds or more
  // to replace a value cached in another Cloudflare location.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${archiveUrl}/v1/archive/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-Flow-Collector-Secret': credential,
        'X-Trace-Flow-Archive-Source': 'claude',
      },
      body: '{}',
    });
    if (response.status === 401) return;
    await sleep(1_000);
  }
  throw new Error('Collector Credential remained active after revocation');
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json();
}

async function archiveExportRequest(
  archiveUrl: string,
  grant: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${archiveUrl}/v1/archive/exports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Flow-Archive-Export-Grant': grant,
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return (await responseJson(response)) as Record<string, unknown>;
}

async function addSelectionManifestKeys(
  archiveUrl: string,
  grant: string,
  selection: ExportSelection,
  archiveObjectKeys: Set<string>,
): Promise<void> {
  for (const [sessionIndex, session] of selection.sessions.entries()) {
    const pending = [session.manifestKey];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const objectKey = pending.pop()!;
      if (seen.has(objectKey)) continue;
      seen.add(objectKey);
      archiveObjectKeys.add(objectKey);
      const response = await archiveExportRequest(archiveUrl, grant, {
        operation: 'manifest',
        selection,
        sessionIndex,
        objectKey,
      });
      const manifest = response.manifest as {
        pages?: { page_key: string }[];
        previous_page_key?: string;
      };
      for (const page of manifest.pages ?? []) pending.push(page.page_key);
      if (manifest.previous_page_key) pending.push(manifest.previous_page_key);
    }
  }
}

function decodeExportBase64(value: unknown): Uint8Array {
  assert.equal(typeof value, 'string');
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

async function captureFixture(
  source: ArchiveSource,
  sourceSessionId: string,
): Promise<CaptureFixture> {
  const result = await captureCommand(
    'cargo',
    [
      'run',
      '--quiet',
      '-p',
      'collector-embedder',
      '--example',
      'archive_capture_fixture',
      '--',
      source,
      sourceSessionId,
    ],
    { cwd: repoRoot },
  );
  if (result.exitCode !== 0) {
    throw new Error(formatProcessFailure('Archive capture fixture', result));
  }
  const fixture = JSON.parse(result.stdout) as CaptureFixture;
  assert.equal(fixture.source_and_spool_removed, true);
  assert.ok(fixture.uploads.length > 0 && fixture.expected_parts.length > 0);
  assert.equal(fixture.request_bodies.length, fixture.uploads.length);
  return fixture;
}

function fixturePayload(part: CaptureFixture['expected_parts'][number]): Uint8Array {
  return part.payload_encoding === 'utf8'
    ? new TextEncoder().encode(part.payload)
    : decodeExportBase64(part.payload);
}

function assertDurableAcknowledgement(
  acknowledgement: ArchiveAcknowledgement,
  expectedSource: ArchiveSource,
  expectedSession: string,
  expectedChainHead: string,
): void {
  assert.equal(acknowledgement.status, 'acknowledged');
  assert.equal(acknowledgement.source, expectedSource);
  assert.equal(acknowledgement.source_session_id, expectedSession);
  assert.equal(acknowledgement.chain_head, expectedChainHead);
  assert.equal(acknowledgement.record_count, 1);
  assert.equal(acknowledgement.generation, 1);
  assert.equal(acknowledgement.duplicate, false);
  assert.equal(acknowledgement.appended_records, 1);
  assert.equal(acknowledgement.appended_checkpoint, true);
  assert.ok(acknowledgement.manifest_key.includes('/manifests/'));
  assert.ok(acknowledgement.chunk_keys.length > 0);
  assert.ok(acknowledgement.chunk_keys.every((key) => key.includes('/chunks/')));
  assert.ok(!acknowledgement.manifest_key.includes(expectedSession));
  assert.ok(acknowledgement.chunk_keys.every((key) => !key.includes(expectedSession)));
}

async function waitForDurableStatus(
  deployment: string,
  tokenIdentifier: string,
  baselineBytes: number,
  startedAt: number,
): Promise<ArchiveStatus> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await runConvex<ArchiveStatus>(
      deployment,
      'api.archive.getStatus',
      {},
      tokenIdentifier,
    );
    if (
      status.storedBytes !== null &&
      status.storedBytes > baselineBytes &&
      status.lastDurableAcknowledgedAt !== null &&
      status.lastDurableAcknowledgedAt >= startedAt
    ) {
      return status;
    }
    await sleep(1_000);
  }
  throw new Error('Archive status did not publish durable bytes before the timeout');
}

async function main(): Promise<void> {
  const deployment = requiredEnvironment('TRACE_FLOW_ARCHIVE_SMOKE_DEPLOYMENT');
  const archiveUrl = requiredEnvironment('TRACE_FLOW_ARCHIVE_SMOKE_URL').replace(/\/$/u, '');
  assert.equal(deployment, expectedDeployment, 'Smoke is restricted to the Cloud-Dev deployment');
  assert.equal(archiveUrl, expectedArchiveUrl, 'Smoke is restricted to the Cloud-Dev Archive API');

  const health = await fetch(`${archiveUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await responseJson(health), { status: 'ok' });

  let primary: SeedResult | undefined;
  let foreign: SeedResult | undefined;
  let minted: MintResult | undefined;
  let enrollment: EnrollmentResult | undefined;
  const archiveObjectKeys = new Set<string>();
  let smokeEvidence: Record<string, unknown> | undefined;
  let smokeFailed = false;
  let smokeFailure: unknown;
  const cleanupFailures: string[] = [];
  let rawExportDirectory: string | undefined;

  try {
    primary = await runConvex<SeedResult>(
      deployment,
      'archiveIntegrationSeed:seedConcurrentEnrollment',
      {},
    );
    foreign = await runConvex<SeedResult>(
      deployment,
      'archiveIntegrationSeed:seedConcurrentEnrollment',
      {},
    );
    await runConvex(deployment, 'api.archive.activate', {}, primary.tokenIdentifier);
    await expectConvexFailure(
      runConvex(
        deployment,
        'api.archive.enroll',
        {
          collectorCredentialId: foreign.collectorCredentialId,
          authorizedSources: [{ source: 'claude', historyChoice: 'new_only' }],
          idempotencyKey: primary.idempotencyKey,
        },
        primary.tokenIdentifier,
      ),
      'Cross-organization enrollment',
      'Collector Credential not found',
    );

    minted = await runConvex<MintResult>(
      deployment,
      'api.collectorCredentials.mint',
      {
        collectorId: `archive-smoke-${crypto.randomUUID()}`,
        expiresAt: Date.now() + 3_600_000,
        name: 'Archive Cloud-Dev smoke',
        platform: 'synthetic',
      },
      primary.tokenIdentifier,
    );
    enrollment = await runConvex<EnrollmentResult>(
      deployment,
      'api.archive.enroll',
      {
        collectorCredentialId: minted.id,
        authorizedSources: [{ source: 'claude', historyChoice: 'new_only' }],
        idempotencyKey: primary.idempotencyKey,
      },
      primary.tokenIdentifier,
    );

    await waitForCredentialPolicy(archiveUrl, minted.secret);
    assert.equal(
      await runConvex<null>(
        deployment,
        'archiveKeysInternal:getActiveVersion',
        { orgId: primary.orgId },
        undefined,
        true,
      ),
      null,
    );
    assert.equal(
      await runConvex<null>(
        deployment,
        'archiveKeysInternal:getCustody',
        { orgId: primary.orgId },
        undefined,
        true,
      ),
      null,
    );

    const baseline = await runConvex<ArchiveStatus>(
      deployment,
      'api.archive.getStatus',
      {},
      primary.tokenIdentifier,
    );
    assert.notEqual(baseline.storedBytes, null);
    const startedAt = Date.now();
    const claudeFixtures = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const session = `claude-smoke-${crypto.randomUUID()}`;
        return { session, fixture: await uploadFixture('claude', session) };
      }),
    );
    const claudeResponses = await Promise.all(
      claudeFixtures.map(({ fixture }) =>
        sendUpload(archiveUrl, minted!.secret, 'claude', fixture.upload),
      ),
    );
    const claudeAcks = await Promise.all(
      claudeResponses.map(async (response, index) => {
        assert.equal(response.status, 200);
        const ack = (await responseJson(response)) as ArchiveAcknowledgement;
        const item = claudeFixtures[index]!;
        assertDurableAcknowledgement(ack, 'claude', item.session, item.fixture.expectedChainHead);
        archiveObjectKeys.add(ack.manifest_key);
        ack.chunk_keys.forEach((key) => archiveObjectKeys.add(key));
        return ack;
      }),
    );
    const firstClaude = claudeFixtures[0];
    const [claudeAck] = claudeAcks;
    assert.ok(firstClaude && claudeAck);
    const { session: claudeSession, fixture: claudeFixture } = firstClaude;
    const activeKey = await runConvex<{ keyVersion: number; wrappedKey: string } | null>(
      deployment,
      'archiveKeysInternal:getActiveVersion',
      { orgId: primary.orgId },
    );
    const custody = await runConvex<{ activeKeyVersion: number } | null>(
      deployment,
      'archiveKeysInternal:getCustody',
      { orgId: primary.orgId },
    );
    assert.ok(activeKey);
    assert.ok(custody);
    assert.equal(activeKey.keyVersion, 1);
    assert.equal(custody.activeKeyVersion, activeKey.keyVersion);

    const retryResponse = await sendUpload(
      archiveUrl,
      minted.secret,
      'claude',
      claudeFixture.upload,
    );
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await responseJson(retryResponse), claudeAck);

    const exportId = `smoke-${crypto.randomUUID()}`;
    const exportGrant = await runConvex<ExportGrantResult>(
      deployment,
      'archiveExport:issueGrant',
      {
        exportId,
        targets: [
          {
            contributionId: enrollment.contributionId,
            source: 'claude',
            sourceSessionId: claudeSession,
          },
        ],
      },
      primary.tokenIdentifier,
    );
    assert.equal(exportGrant.archiveUrl, archiveUrl);
    assert.equal(exportGrant.exportId, exportId);
    assert.ok(exportGrant.expiresAt > Math.floor(Date.now() / 1000));
    const selected = await archiveExportRequest(archiveUrl, exportGrant.grant, {
      operation: 'select',
    });
    const selection = selected.selection as ExportSelection;
    assert.equal(selection.exportId, exportId);
    await addSelectionManifestKeys(archiveUrl, exportGrant.grant, selection, archiveObjectKeys);
    const manifestResponse = await archiveExportRequest(archiveUrl, exportGrant.grant, {
      operation: 'manifest',
      selection,
      sessionIndex: 0,
      objectKey: selection.sessions[0]!.manifestKey,
    });
    const manifest = manifestResponse.manifest as {
      elements: {
        element_type: string;
        content_sha256?: string;
        byte_range: { chunk_id: string; start: number; end: number };
      }[];
    };
    const record = manifest.elements.find((element) => element.element_type === 'record');
    assert.ok(record?.content_sha256);
    const chunkResponse = await archiveExportRequest(archiveUrl, exportGrant.grant, {
      operation: 'chunk',
      selection,
      sessionIndex: 0,
      chunkId: record.byte_range.chunk_id,
    });
    const chunk = decodeExportBase64(chunkResponse.payload_base64);
    const storedRecord = JSON.parse(
      new TextDecoder()
        .decode(chunk.subarray(record.byte_range.start, record.byte_range.end))
        .trim(),
    ) as ArchiveObservation;
    const expectedObservation = claudeFixture.upload.observations[0]!;
    assert.equal(storedRecord.content_sha256, expectedObservation.content_sha256);
    assert.equal(storedRecord.payload, expectedObservation.payload);

    const resumed = await archiveExportRequest(archiveUrl, exportGrant.grant, {
      operation: 'select',
      selection,
    });
    assert.deepEqual(resumed, selected);

    const codexSession = `codex-smoke-${crypto.randomUUID()}`;
    const codexFixture = await uploadFixture('codex', codexSession);
    const denied = await sendUpload(archiveUrl, minted.secret, 'codex', codexFixture.upload);
    assert.equal(denied.status, 403);
    assert.deepEqual(await responseJson(denied), {
      error: 'forbidden',
      reason: 'source_unauthorized',
    });

    await runConvex(
      deployment,
      'api.archive.addAuthorizedSource',
      { enrollmentId: enrollment.enrollmentId, source: 'codex', historyChoice: 'new_only' },
      primary.tokenIdentifier,
    );
    const codexResponse = await sendUpload(archiveUrl, minted.secret, 'codex', codexFixture.upload);
    assert.equal(codexResponse.status, 200);
    const codexAck = (await responseJson(codexResponse)) as ArchiveAcknowledgement;
    assertDurableAcknowledgement(codexAck, 'codex', codexSession, codexFixture.expectedChainHead);
    archiveObjectKeys.add(codexAck.manifest_key);
    codexAck.chunk_keys.forEach((key) => archiveObjectKeys.add(key));

    const rawFixtures = await Promise.all(
      (['claude', 'codex'] as const).map(async (source) => {
        const session = `${source}-raw-smoke-${crypto.randomUUID()}`;
        return { source, session, fixture: await captureFixture(source, session) };
      }),
    );
    for (const { source, fixture } of rawFixtures) {
      for (const [index, body] of fixture.request_bodies.entries()) {
        const upload = fixture.uploads[index]!;
        const response = await sendUploadBody(archiveUrl, minted.secret, source, body);
        assert.equal(response.status, 200);
        const acknowledgement = (await responseJson(response)) as ArchiveAcknowledgement;
        const bodyDigest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
        );
        assert.equal(
          acknowledgement.request_sha256,
          `sha256:${Array.from(bodyDigest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
        );
        assert.equal(
          acknowledgement.source_transcript_part_id,
          upload.checkpoint.source_transcript_part_id,
        );
        assert.equal(
          acknowledgement.captured_byte_offset,
          upload.checkpoint.last_complete_byte_offset,
        );
        assert.equal(
          acknowledgement.captured_prefix_sha256,
          upload.checkpoint.complete_prefix_sha256,
        );
        archiveObjectKeys.add(acknowledgement.manifest_key);
        acknowledgement.chunk_keys.forEach((key) => archiveObjectKeys.add(key));
        const replay = await sendUploadBody(archiveUrl, minted.secret, source, body);
        assert.equal(replay.status, 200);
        assert.deepEqual(await responseJson(replay), acknowledgement);
      }
    }
    const rawExportId = `raw-smoke-${crypto.randomUUID()}`;
    const rawGrant = await runConvex<ExportGrantResult>(
      deployment,
      'archiveExport:issueGrant',
      {
        exportId: rawExportId,
        targets: rawFixtures
          .map(({ source, session }) => ({
            contributionId: enrollment!.contributionId,
            source,
            sourceSessionId: session,
          }))
          .concat({
            contributionId: enrollment.contributionId,
            source: 'codex',
            sourceSessionId: codexSession,
          }),
      },
      primary.tokenIdentifier,
    );
    rawExportDirectory = await mkdtemp(resolve(tmpdir(), 'trace-flow-archive-export-smoke-'));
    const exportEnvironment = {
      ...process.env,
      TRACE_FLOW_ARCHIVE_EXPORT_GRANT: rawGrant.grant,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await captureCommand(
        process.execPath,
        ['scripts/dev/archive-export.ts', archiveUrl, rawExportDirectory],
        { cwd: repoRoot, env: exportEnvironment },
      );
      if (result.exitCode !== 0) {
        throw new Error(formatProcessFailure('Archive export client', result, [rawGrant.grant]));
      }
      assert.equal(result.stdout.trim(), rawExportDirectory);
    }

    const localExport = JSON.parse(
      await readFile(resolve(rawExportDirectory, 'archive-manifest.json'), 'utf8'),
    ) as LocalExportManifest;
    assert.ok(localExport.sessions.every(({ status }) => status === 'verified'));
    assert.equal(localExport.selection.sessions.length, rawFixtures.length + 1);
    await addSelectionManifestKeys(
      archiveUrl,
      rawGrant.grant,
      localExport.selection,
      archiveObjectKeys,
    );
    for (const { source, session, fixture } of rawFixtures) {
      const selectedSession = localExport.selection.sessions.find(
        (candidate) => candidate.source === source && candidate.sourceSessionId === session,
      );
      assert.ok(selectedSession);
      assert.equal(selectedSession.contributionId, enrollment.contributionId);
      const sessionDirectory = resolve(
        rawExportDirectory,
        'sessions',
        source,
        await exportSessionDirectoryId(selectedSession.contributionId, session),
      );
      const localSession = JSON.parse(
        await readFile(resolve(sessionDirectory, 'manifest.json'), 'utf8'),
      ) as LocalSessionManifest;
      assert.equal(localSession.parts.length, fixture.expected_parts.length);
      for (const expected of fixture.expected_parts) {
        const restored = localSession.parts.find(
          (part) => part.source_transcript_part_id === expected.part_id,
        );
        assert.ok(restored);
        assert.equal(restored.byte_exact, true);
        assert.equal(restored.sha256, expected.sha256);
        assert.equal(restored.source_capture_complete, true);
        const bytes = new Uint8Array(await readFile(resolve(sessionDirectory, restored.file)));
        assert.deepEqual(bytes, fixturePayload(expected));
        assert.equal(restored.byte_length, bytes.byteLength);
        assert.equal(restored.observed_source_size, bytes.byteLength);
        assert.equal(
          `sha256:${Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('')}`,
          expected.sha256,
        );
      }
    }

    const durableStatus = await waitForDurableStatus(
      deployment,
      primary.tokenIdentifier,
      baseline.storedBytes ?? 0,
      startedAt,
    );
    assert.equal(durableStatus.lifecycle, 'active');
    assert.ok(durableStatus.capBytes > (durableStatus.storedBytes ?? 0));
    assert.ok(
      durableStatus.integritySessions.every(
        ({ sourceSessionId }) =>
          sourceSessionId !== claudeSession && sourceSessionId !== codexSession,
      ),
    );
    const audit = await runConvex<{ action: string; outcome: string }[]>(
      deployment,
      'api.archiveAudit.listEvents',
      {},
      primary.tokenIdentifier,
    );
    assert.ok(audit.some((event) => event.action === 'activation' && event.outcome === 'success'));
    assert.ok(audit.some((event) => event.action === 'enrollment' && event.outcome === 'success'));

    smokeEvidence = {
      status: 'ok',
      sources: ['claude', 'codex'],
      persistedObjects: archiveObjectKeys.size,
      storedBytesIncreased: (durableStatus.storedBytes ?? 0) > (baseline.storedBytes ?? 0),
      idempotentRetry: true,
      sourcePolicyFailure: true,
      crossOrganizationFailure: true,
      firstKeyBootstrap: true,
      auditEventsVerified: true,
      exportVerified: true,
      exportResumeVerified: true,
      rawCaptureRestoreVerified: true,
    };
  } catch (error) {
    smokeFailed = true;
    smokeFailure = error;
  } finally {
    const cleanup = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if (primary && minted) {
      await cleanup('minted Collector Credential revocation', () =>
        runConvex(
          deployment,
          'api.collectorCredentials.revoke',
          { id: minted!.id },
          primary!.tokenIdentifier,
          true,
        ),
      );
      await cleanup('minted Collector Credential KV deletion', () =>
        waitForCredentialRevocation(archiveUrl, minted!.secret),
      );
    }
    if (primary && enrollment) {
      await cleanup('archive unenrollment', () =>
        runConvex(
          deployment,
          'api.archive.unenroll',
          { enrollmentId: enrollment!.enrollmentId },
          primary!.tokenIdentifier,
          true,
        ),
      );
    }
    if (rawExportDirectory) {
      await cleanup('local archive export deletion', () =>
        rm(rawExportDirectory!, { recursive: true, force: true }),
      );
    }
    await cleanup('R2 object deletion', () => deleteArchiveObjects(archiveObjectKeys));
    if (foreign) {
      await cleanup('foreign organization deletion', () =>
        runConvex(
          deployment,
          'archiveIntegrationSeed:cleanupConcurrentEnrollment',
          { orgId: foreign!.orgId },
          undefined,
          true,
        ),
      );
    }
    if (primary) {
      await cleanup('primary organization deletion', () =>
        runConvex(
          deployment,
          'archiveIntegrationSeed:cleanupConcurrentEnrollment',
          { orgId: primary!.orgId },
          undefined,
          true,
        ),
      );
    }
    if (minted) minted.secret = '';
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`Archive smoke cleanup failed: ${cleanupFailures.join(', ')}`, {
      cause: smokeFailure,
    });
  }
  if (smokeFailed) throw smokeFailure;
  assert.ok(smokeEvidence);
  console.log(JSON.stringify({ ...smokeEvidence, cleanupVerified: true }));
}

await main();
