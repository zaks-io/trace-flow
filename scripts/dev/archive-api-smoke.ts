import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import {
  createArchiveEncryptionKeyVersion,
  serializeArchiveWrappedKeyVersion,
} from '../../packages/utils/src/archive-crypto';
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

const repoRoot = resolve(import.meta.dirname, '../..');
const expectedDeployment = 'hardy-iguana-812';
const expectedArchiveUrl = 'https://trace-flow-archive-api-dev.isaac-a46.workers.dev';

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
}

interface ArchiveStatus {
  lifecycle: string;
  capBytes: number;
  storedBytes: number | null;
  lastDurableAcknowledgedAt: number | null;
  integritySessions: { source: ArchiveSource; sourceSessionId: string }[];
}

class ConvexCommandError extends Error {
  constructor(
    functionName: string,
    readonly expectedAuthorizationFailure: boolean,
  ) {
    super(`${functionName} failed`);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runConvex<T>(
  deployment: string,
  functionName: string,
  args: Record<string, unknown>,
  tokenIdentifier?: string,
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

  return new Promise((resolveResult, reject) => {
    const child = spawn(cli, cliArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', () => reject(new Error(`Unable to start ${functionName}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new ConvexCommandError(functionName, stderr.includes('Collector Credential not found')),
        );
        return;
      }
      try {
        resolveResult(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`${functionName} returned invalid JSON`));
      }
    });
  });
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
    throw new Error(`${label} failed for an unexpected reason`);
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
    complete_prefix_base64: Buffer.from(prefix).toString('base64'),
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

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json();
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
  const wrappingSecret = requiredEnvironment('ARCHIVE_KEY_WRAPPING_SECRET');
  assert.equal(deployment, expectedDeployment, 'Smoke is restricted to the Cloud-Dev deployment');
  assert.equal(archiveUrl, expectedArchiveUrl, 'Smoke is restricted to the Cloud-Dev Archive API');

  const health = await fetch(`${archiveUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await responseJson(health), { status: 'ok' });

  const primary = await runConvex<SeedResult>(
    deployment,
    'archiveIntegrationSeed:seedConcurrentEnrollment',
    {},
  );
  const foreign = await runConvex<SeedResult>(
    deployment,
    'archiveIntegrationSeed:seedConcurrentEnrollment',
    {},
  );
  let minted: MintResult | undefined;
  let enrollment: EnrollmentResult | undefined;

  try {
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

    const wrappedKey = await createArchiveEncryptionKeyVersion({
      orgId: primary.orgId,
      keyVersion: 1,
      wrappingSecretBase64: wrappingSecret,
    });
    await runConvex(deployment, 'archiveKeysInternal:storeVersion', {
      orgId: primary.orgId,
      keyVersion: 1,
      wrappedKey: serializeArchiveWrappedKeyVersion(wrappedKey),
    });

    const baseline = await runConvex<ArchiveStatus>(
      deployment,
      'api.archive.getStatus',
      {},
      primary.tokenIdentifier,
    );
    assert.notEqual(baseline.storedBytes, null);
    const startedAt = Date.now();
    const claudeSession = `claude-smoke-${crypto.randomUUID()}`;
    const claudeFixture = await uploadFixture('claude', claudeSession);

    let claudeResponse: Response | undefined;
    const credentialSyncDeadline = Date.now() + 30_000;
    while (Date.now() < credentialSyncDeadline) {
      claudeResponse = await sendUpload(archiveUrl, minted.secret, 'claude', claudeFixture.upload);
      if (claudeResponse.status !== 401) break;
      await sleep(1_000);
    }
    assert.ok(claudeResponse);
    assert.equal(claudeResponse.status, 200);
    const claudeAck = (await responseJson(claudeResponse)) as ArchiveAcknowledgement;
    assertDurableAcknowledgement(
      claudeAck,
      'claude',
      claudeSession,
      claudeFixture.expectedChainHead,
    );

    const retryResponse = await sendUpload(
      archiveUrl,
      minted.secret,
      'claude',
      claudeFixture.upload,
    );
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await responseJson(retryResponse), claudeAck);

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

    console.log(
      JSON.stringify({
        status: 'ok',
        sources: ['claude', 'codex'],
        persistedObjects: claudeAck.chunk_keys.length + codexAck.chunk_keys.length + 2,
        storedBytesIncreased: (durableStatus.storedBytes ?? 0) > (baseline.storedBytes ?? 0),
        idempotentRetry: true,
        sourcePolicyFailure: true,
        crossOrganizationFailure: true,
        auditEventsVerified: true,
      }),
    );
  } finally {
    if (enrollment) {
      await runConvex(
        deployment,
        'api.archive.unenroll',
        { enrollmentId: enrollment.enrollmentId },
        primary.tokenIdentifier,
      ).catch(() => undefined);
    }
    for (const credentialId of [minted?.id, primary.collectorCredentialId]) {
      if (!credentialId) continue;
      await runConvex(
        deployment,
        'api.collectorCredentials.revoke',
        { id: credentialId },
        primary.tokenIdentifier,
      ).catch(() => undefined);
    }
    await runConvex(deployment, 'archiveIntegrationSeed:cleanupConcurrentEnrollment', {
      orgId: foreign.orgId,
    }).catch(() => undefined);
    if (minted) minted.secret = '';
  }
}

await main();
