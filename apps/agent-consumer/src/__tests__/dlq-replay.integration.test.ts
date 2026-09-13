import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import { env as workerEnv } from 'cloudflare:workers';
import { sha256Hex } from '@trace-flow/utils';
import type { AgentConsumerEnv } from '../context';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { TraceRecovery } from '../index';
import { emptyQueueFacts, queueMessage, toolEventFact } from './factories';

const env = workerEnv as unknown as AgentConsumerEnv;

function malformedBody(orgId: string, over: Record<string, unknown> = {}) {
  return queueMessage({
    tenancy: {
      org_id: orgId,
      user_id: 'user-1',
      collector_id: 'collector-1',
      collector_credential_id: 'cred-1',
    },
    facts: {
      ...emptyQueueFacts(),
      tool_events: [
        toolEventFact({
          session_pk: `session-${crypto.randomUUID()}`,
          tool_use_pk: `tool-${crypto.randomUUID()}`,
          error_excerpt: '😀'.repeat(1_025),
          ...over,
        }),
      ],
    },
  });
}

async function preserve(body: unknown, shardId = '__dlq__') {
  const source = env.AGENT_FACT_BATCHER.getByName(`org:${shardId}`);
  const payload = JSON.stringify({
    queue: 'agent-ingest-dlq-prod',
    messageId: crypto.randomUUID(),
    body,
  });
  const record = await source.preserveDlq(
    payload,
    JSON.stringify({ reason: 'dead_letter_queue_delivery' }),
    crypto.randomUUID(),
  );
  return { payload, record, source };
}

async function expectBlocked(source: DurableObjectStub<AgentFactBatcherInstance>, id: number) {
  await expect(source.getRecovery(id)).resolves.toMatchObject({
    state: 'blocked',
    resolution: null,
  });
}

describe('TraceRecovery excerpt repair', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stages a corrected Unicode body, resolves with hashes, and preserves the original payload', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const { payload, record, source } = await preserve(malformedBody(orgId));
    const expectedPayloadSha256 = await sha256Hex(payload);
    const recovery = new TraceRecovery(createExecutionContext(), env);

    const resolved = await recovery.replayDlq('__dlq__', {
      recoveryId: record.id,
      reason: 'repair the confirmed UTF-8 excerpt overflow',
      repair: { kind: 'excerpt-byte-limits', expectedPayloadSha256, expectedOrgId: orgId },
    });

    expect(resolved).toMatchObject({ state: 'resolved', resolution: 'replayed', payload });
    const audit = JSON.parse(resolved.resolutionReason!) as {
      reason: string;
      repair: Record<string, string>;
    };
    expect(audit.reason).toBe('repair the confirmed UTF-8 excerpt overflow');
    expect(audit.repair).toMatchObject({
      kind: 'excerpt-byte-limits',
      expectedOrgId: orgId,
      originalPayloadSha256: expectedPayloadSha256,
    });
    expect(audit.repair.originalBodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.repair.correctedBodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.repair.correctedBodySha256).not.toBe(audit.repair.originalBodySha256);
    await expect(source.getRecovery(record.id)).resolves.toMatchObject({ payload });
    await expect(
      env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`).getStats(),
    ).resolves.toMatchObject({ queuedRows: 1 });
  });

  it('rejects a wrong payload hash before staging or resolving', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const { record, source } = await preserve(malformedBody(orgId));
    const recovery = new TraceRecovery(createExecutionContext(), env);

    await expect(
      recovery.replayDlq('__dlq__', {
        recoveryId: record.id,
        reason: 'hash mismatch test',
        repair: {
          kind: 'excerpt-byte-limits',
          expectedPayloadSha256: '0'.repeat(64),
          expectedOrgId: orgId,
        },
      }),
    ).rejects.toThrow('payload hash does not match');
    await expectBlocked(source, record.id);
  });

  it('rejects a wrong organization before staging or resolving', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const { payload, record, source } = await preserve(malformedBody(orgId));
    const recovery = new TraceRecovery(createExecutionContext(), env);

    await expect(
      recovery.replayDlq('__dlq__', {
        recoveryId: record.id,
        reason: 'org mismatch test',
        repair: {
          kind: 'excerpt-byte-limits',
          expectedPayloadSha256: await sha256Hex(payload),
          expectedOrgId: `org-${crypto.randomUUID()}`,
        },
      }),
    ).rejects.toThrow('payload org does not match');
    await expectBlocked(source, record.id);
  });

  it('rejects a non-exact organization binding before staging or resolving', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const { payload, record, source } = await preserve(malformedBody(orgId));
    const recovery = new TraceRecovery(createExecutionContext(), env);

    await expect(
      recovery.replayDlq('__dlq__', {
        recoveryId: record.id,
        reason: 'non-exact org test',
        repair: {
          kind: 'excerpt-byte-limits',
          expectedPayloadSha256: await sha256Hex(payload),
          expectedOrgId: ` ${orgId}`,
        },
      }),
    ).rejects.toThrow('invalid DLQ repair request');
    await expectBlocked(source, record.id);
  });

  it('keeps unrelated malformed payloads blocked', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const body = malformedBody(orgId, { status: 'not-a-status' });
    const { payload, record, source } = await preserve(body);
    const recovery = new TraceRecovery(createExecutionContext(), env);

    await expect(
      recovery.replayDlq('__dlq__', {
        recoveryId: record.id,
        reason: 'unrelated malformed field test',
        repair: {
          kind: 'excerpt-byte-limits',
          expectedPayloadSha256: await sha256Hex(payload),
          expectedOrgId: orgId,
        },
      }),
    ).rejects.toThrow('remains invalid after excerpt repair');
    await expectBlocked(source, record.id);
  });

  it('keeps a no-op repair blocked', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const body = malformedBody(orgId, { error_excerpt: '', status: 'not-a-status' });
    const { payload, record, source } = await preserve(body);
    const recovery = new TraceRecovery(createExecutionContext(), env);

    await expect(
      recovery.replayDlq('__dlq__', {
        recoveryId: record.id,
        reason: 'no-op repair test',
        repair: {
          kind: 'excerpt-byte-limits',
          expectedPayloadSha256: await sha256Hex(payload),
          expectedOrgId: orgId,
        },
      }),
    ).rejects.toThrow('no overlong');
    await expectBlocked(source, record.id);
  });

  it('keeps the source blocked when durable destination staging fails', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const destination = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    await destination.beginFactRebuild(orgId, {
      operationId: `repair-lock-${crypto.randomUUID()}`,
      executorId: crypto.randomUUID(),
      reason: 'force the recovery replay staging failure',
      tinybirdWorkspaceId: '33333333-3333-4333-8333-333333333333',
      tinybirdTokenFingerprints: [
        '02678c7d0b2ede6174be0b3e990a2a3cd18a45640f35d6ae636f6342acba2e4e',
      ],
    });
    const { payload, record, source } = await preserve(malformedBody(orgId));
    const recovery = new TraceRecovery(createExecutionContext(), env);

    await expect(
      recovery.replayDlq('__dlq__', {
        recoveryId: record.id,
        reason: 'destination staging failure test',
        repair: {
          kind: 'excerpt-byte-limits',
          expectedPayloadSha256: await sha256Hex(payload),
          expectedOrgId: orgId,
        },
      }),
    ).rejects.toThrow('was not durably staged');
    await expectBlocked(source, record.id);
  });

  it('resolves a migrated DLQ record only after the bounded delivery commits', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const body = queueMessage({
      tenancy: {
        org_id: orgId,
        user_id: 'user-1',
        collector_id: 'collector-1',
        collector_credential_id: 'cred-1',
      },
    });
    const { record, source } = await preserve(body, orgId);
    await completeMigration(orgId);
    const writes = mockDeliveryTransport();
    const recovery = new TraceRecovery(createExecutionContext(), env);

    const resolved = await recovery.replayDlq(orgId, {
      recoveryId: record.id,
      reason: 'replay through the completed bounded migration',
    });

    expect(resolved).toMatchObject({ state: 'resolved', resolution: 'replayed' });
    expect(writes.flat()).toEqual([
      expect.objectContaining({ OrgId: orgId, DeliverySequence: 2, IsDeleted: 0 }),
    ]);
    await expect(source.getRecovery(record.id)).resolves.toMatchObject({ state: 'resolved' });
    await expect(
      env.AGENT_DELIVERIES.list({ prefix: `agent-deliveries/${orgId}/` }),
    ).resolves.toMatchObject({ objects: [] });
    await expect(
      env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`).getStats(),
    ).resolves.toMatchObject({ queuedRows: 0 });
  });
});

async function completeMigration(orgId: string): Promise<void> {
  const migrationId = 'bounded-agent-ingestion-v1';
  const proofSha256 = 'a'.repeat(64);
  await env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`).freezeIngestionMigration(migrationId);
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  await coordinator.seedIngestionMigration({ proofSha256, dirtyDays: [] });
  await coordinator.completeIngestionMigration({ proofSha256 });
}

function mockDeliveryTransport(): Record<string, unknown>[][] {
  const writes: Record<string, unknown>[][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('agent_fact_identity_day')) {
        return Response.json({ data: [] });
      }
      if (url.pathname.includes('agent_delivery_receipt')) return Response.json({ data: [] });
      if (url.pathname === '/v0/events') {
        const rows = String(init?.body)
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        writes.push(rows);
        return Response.json({ successful_rows: rows.length, quarantined_rows: 0 });
      }
      throw new Error(`Unexpected test request ${url.pathname}`);
    }),
  );
  return writes;
}
