import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { ArchiveRecovery } from '../index';
import type { ArchiveApiEnv } from '../context';
import {
  base64,
  call,
  checkpoint,
  digest,
  envelope,
  exactPrefix,
  fallbackArchiveKeyHttp,
  newLedger,
  observation,
  partFor,
  runtimeEnv,
  scope,
} from './ledger.integration.fixtures';
import type { ArchiveSessionLedger } from './ledger.integration.fixtures';

describe('operator archive repair publication recovery', () => {
  let auditBodies: Record<string, unknown>[];
  let statusBodies: Record<string, unknown>[];
  let auditFailuresRemaining: number;

  beforeEach(() => {
    auditBodies = [];
    statusBodies = [];
    auditFailuresRemaining = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as Record<string, unknown> | null;
      const pathname = new URL(request.url).pathname;
      if (pathname === '/archive-api/audit-events') {
        if (auditFailuresRemaining > 0) {
          auditFailuresRemaining -= 1;
          return new Response(null, { status: 503 });
        }
        auditBodies.push(body ?? {});
        return Response.json({ eventId: crypto.randomUUID(), created: true });
      }
      if (pathname === '/archive-api/session-integrity') {
        statusBodies.push(body ?? {});
        return Response.json(body);
      }
      const response = await fallbackArchiveKeyHttp(
        pathname,
        typeof body?.orgId === 'string' ? body.orgId : '',
      );
      if (response) return response;
      throw new Error(`unexpected request: ${pathname}`);
    });
  });

  it('drains the durable attempt before verification mutates and retries its failure outcome', async () => {
    const currentScope = scope('codex', `repair-audit-${crypto.randomUUID()}`);
    const partId = partFor('codex');
    const records = [
      await observation(
        'codex',
        currentScope.sourceSessionId,
        partId,
        'line-0',
        JSON.stringify({ index: 0 }),
        1_700_000_000_000,
      ),
    ];
    const originalCheckpoint = await checkpoint(
      'codex',
      currentScope.sourceSessionId,
      partId,
      records,
    );
    const stub = newLedger(currentScope);
    const initialUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: records,
      checkpoint: originalCheckpoint,
      complete_prefix_base64: base64(exactPrefix(records)),
    };
    expect((await call(stub, await envelope(currentScope, initialUpload))).response.status).toBe(
      200,
    );
    const recovery = new ArchiveRecovery(
      createExecutionContext(),
      runtimeEnv as unknown as ArchiveApiEnv,
    );
    const inspected = (await recovery.inspectArchivePart(partId, {
      scope: currentScope,
    })) as { state: Record<string, unknown> };
    const operationId = crypto.randomUUID();
    const snapshotSha256 = await digest(exactPrefix(records));

    for (const malformed of [
      { operationId: '', snapshotSha256 },
      { operationId: crypto.randomUUID(), snapshotSha256: 'invalid-digest' },
    ]) {
      await expect(
        runInDurableObject(stub, (instance: ArchiveSessionLedger) =>
          instance.applyArchiveRepairChunk({
            scope: currentScope,
            upload: initialUpload,
            operationId: malformed.operationId,
            plan: { snapshotSha256: malformed.snapshotSha256 },
            expected: inspected.state,
            chunkIndex: 0,
            chunkKind: 'rebase',
          } as never),
        ),
      ).rejects.toThrow('archive_repair_invalid');
    }
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec('SELECT operation_id FROM ledger_repair_publications'),
      ]),
    ).toHaveLength(0);

    auditFailuresRemaining = 2;

    await expect(
      runInDurableObject(stub, (instance: ArchiveSessionLedger) =>
        instance.verifyArchiveRepairPage({
          scope: currentScope,
          partId,
          operationId,
          snapshotSha256,
          phase: 'before',
          expected: inspected.state as never,
        }),
      ),
    ).rejects.toThrow('Failed to append archive audit event');
    expect(
      await runInDurableObject(stub, (_instance, state) => ({
        verificationRows: [
          ...state.storage.sql.exec(
            'SELECT operation_id FROM ledger_verifications WHERE operation_id = ?',
            operationId,
          ),
        ].length,
        pendingPublications: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM ledger_repair_publications WHERE operation_id = ? AND delivered_at IS NULL',
            operationId,
          ),
        ][0]?.count,
      })),
    ).toEqual({ verificationRows: 0, pendingPublications: 3 });

    await runInDurableObject(stub, (instance: ArchiveSessionLedger) => instance.alarm());
    expect(
      auditBodies.filter((body) => body.operationId === `${operationId}:attempt_audit`),
    ).toHaveLength(1);
    expect(
      auditBodies.filter((body) => body.operationId === `${operationId}:failure_audit`),
    ).toHaveLength(1);
    expect(statusBodies.filter((body) => body.repairOutcome === 'failure')).toHaveLength(1);

    await expect(
      recovery.verifyArchiveRepairPage(partId, {
        scope: currentScope,
        operationId,
        snapshotSha256,
        phase: 'before',
        expected: inspected.state,
      }),
    ).resolves.toMatchObject({ operationId, phase: 'before' });
    expect(
      auditBodies.filter((body) => body.operationId === `${operationId}:attempt_audit`),
    ).toHaveLength(1);
  });
});
