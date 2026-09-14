import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecoveryRecord } from '../../packages/tinybird-client/src/recovery';
import { stableHash } from '../../apps/agent-consumer/src/facts';
import { CanonicalHashIndex, type SourceSchema } from './agent-canonical-index';
import { FrozenRepairReconciliationJournal } from './agent-frozen-repair-journal';
import { reconcileAllFrozenRepairs } from './agent-frozen-repair-reconciliation';
import { normalized, type AgentRecoveryClient } from './agent-transport';

const orgId = 'org-a';
const today = '2026-09-13';
const oldestDay = '2025-09-14';

test('reconciles repeated repair history using exact, strictly newer, and expired proofs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-frozen-repairs-'));
  const schema = sourceSchema();
  const older = source(schema, 'repeated', `${today} 01:00:00.000`, today, 1);
  const latest = source(schema, 'repeated', `${today} 02:00:00.000`, today, 2);
  const expired = source(schema, 'expired', `${oldestDay} 01:00:00.000`, '2025-09-13', 3);
  const repeatedId = `${orgId}\x1fsession\x1frepeated`;
  const records = [repair(7, older), repair(8, latest), repair(9, expired)];
  const proofs: any[] = [];
  let reconciliationCalls = 0;
  const recovery = {
    org: orgId,
    call: async (method: string, input: any) => {
      if (method === 'listRecovery') return { records, nextAfterId: null };
      if (method === 'reconcileFrozenRepairs') {
        reconciliationCalls++;
        proofs.push(...input.repairs);
        return {
          resolved: input.repairs.map((proof: any) => ({
            recoveryId: proof.recoveryId,
            resolution: `frozen-journal-${proof.disposition}`,
          })),
          storage: {
            databaseSizeBeforeBytes: 100,
            databaseSizeAfterBytes: 100,
            releasedRecoveryBytes: 300,
            hydratedRepairBytes: 100,
            tombstoneBytes: 50,
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  } as unknown as AgentRecoveryClient;
  const index = new CanonicalHashIndex(
    join(directory, 'canonical.sqlite'),
    orgId,
    'host',
    oldestDay,
    today,
  );
  const journal = new FrozenRepairReconciliationJournal(
    join(directory, 'reconciliation.sqlite'),
    journalFence(),
  );
  try {
    index.saveSourceSchema('messages', schema);
    index.savePage(
      'messages',
      today,
      [
        {
          category: 'messages',
          factId: repeatedId,
          eventDay: today,
          deliverySequence: 3,
          contentHash: '1'.repeat(64),
          ingestedAtMs: Date.parse(`${today}T02:00:00.000Z`),
          rowSha256: rowSha256(latest, schema),
        },
      ],
      'session',
      'repeated',
    );
    index.beginExport(3);
    index.finishExport(3);

    const result = await reconcileAllFrozenRepairs(
      recovery,
      index,
      {
        migrationProofSha256: 'a'.repeat(64),
        deliverySequence: 3,
        fullVerificationSha256: 'b'.repeat(64),
      },
      journal,
    );
    expect(result).toMatchObject({ total: 3, exact: 1, superseded: 1, expired: 1 });
    expect(proofs.map(({ recoveryId, disposition }) => [recoveryId, disposition])).toEqual([
      [7, 'superseded'],
      [8, 'exact'],
      [9, 'expired'],
    ]);
    expect(reconciliationCalls).toBe(1);
    expect(
      proofs.every(({ fullVerificationSha256 }) => fullVerificationSha256 === 'b'.repeat(64)),
    ).toBe(true);
  } finally {
    journal.close();
    index.close();
    rmSync(directory, { recursive: true });
  }
});

test('rejects a same-ingestion-time canonical conflict before mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-frozen-repair-conflict-'));
  const schema = sourceSchema();
  const repairRow = source(schema, 'conflict', `${today} 02:00:00.000`, today, 1);
  const canonical = { ...repairRow, model: 'different' };
  const record = repair(11, repairRow);
  let mutations = 0;
  const recovery = {
    org: orgId,
    call: async (method: string) => {
      if (method === 'listRecovery') return { records: [record], nextAfterId: null };
      if (method === 'reconcileFrozenRepairs') mutations++;
      throw new Error(`Unexpected method ${method}`);
    },
  } as unknown as AgentRecoveryClient;
  const index = new CanonicalHashIndex(
    join(directory, 'canonical.sqlite'),
    orgId,
    'host',
    oldestDay,
    today,
  );
  const journal = new FrozenRepairReconciliationJournal(
    join(directory, 'reconciliation.sqlite'),
    journalFence(),
  );
  try {
    index.saveSourceSchema('messages', schema);
    index.savePage(
      'messages',
      today,
      [
        {
          category: 'messages',
          factId: `${orgId}\x1fsession\x1fconflict`,
          eventDay: today,
          deliverySequence: 3,
          contentHash: '2'.repeat(64),
          ingestedAtMs: Date.parse(`${today}T02:00:00.000Z`),
          rowSha256: rowSha256(canonical, schema),
        },
      ],
      'session',
      'conflict',
    );
    index.beginExport(3);
    index.finishExport(3);
    await expect(
      reconcileAllFrozenRepairs(
        recovery,
        index,
        {
          migrationProofSha256: 'a'.repeat(64),
          deliverySequence: 3,
          fullVerificationSha256: 'b'.repeat(64),
        },
        journal,
      ),
    ).rejects.toThrow('conflicts with canonical facts');
    expect(mutations).toBe(0);
  } finally {
    journal.close();
    index.close();
    rmSync(directory, { recursive: true });
  }
});

function repair(id: number, row: Record<string, unknown>): RecoveryRecord {
  const factId = `${orgId}\x1f${row.session_pk}\x1f${row.message_pk}`;
  return {
    id,
    kind: 'repair',
    state: 'blocked',
    classification: 'changed',
    target: null,
    payload: JSON.stringify(row),
    outcome: JSON.stringify({
      category: 'messages',
      factId,
      newHash: stableHash(row),
      oldHash: '0'.repeat(16),
      originalPayload: null,
    }),
    createdAtMs: 1,
    resolvedAtMs: null,
    resolution: null,
    resolutionReason: null,
  };
}

function journalFence() {
  return {
    orgId,
    migrationProofSha256: 'a'.repeat(64),
    deliverySequence: 3,
    oldestDay,
    todayDay: today,
    fullVerificationSha256: 'b'.repeat(64),
  };
}

function source(
  schema: SourceSchema,
  id: string,
  ingestedAt: string,
  eventDay: string,
  cost: number,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      schema.meta.map(({ name, type }) => [
        name,
        type.startsWith('DateTime')
          ? `${eventDay} 01:00:00.000`
          : type.startsWith('Nullable')
            ? null
            : /Int|Float/.test(type)
              ? 0
              : 'value',
      ]),
    ),
    OrgId: orgId,
    session_pk: 'session',
    message_pk: id,
    EventAt: `${eventDay} 01:00:00.000`,
    IngestedAt: ingestedAt,
    cost_usd: cost,
  };
}

function sourceSchema(): SourceSchema {
  const meta = [
    ...readFileSync('datasources/agent_message_facts.datasource', 'utf8').matchAll(
      /^\s+`([^`]+)`\s+([^\s,]+)/gm,
    ),
  ].map((match) => ({ name: match[1]!, type: match[2]! }));
  return { columns: meta.map(({ name }) => `\`${name}\``), meta };
}

function rowSha256(row: Record<string, unknown>, schema: SourceSchema): string {
  return createHash('sha256')
    .update(JSON.stringify(normalized(row, schema.meta)))
    .digest('hex');
}
