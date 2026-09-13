import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableHash } from '../../apps/agent-consumer/src/facts';
import { CanonicalHashIndex, type SourceSchema } from './agent-canonical-index';
import { verifyAllFrozenFacts } from './agent-frozen-verification';
import { normalized, type AgentRecoveryClient } from './agent-transport';

test('full frozen verification distinguishes exact, newer, and retention-expired sources', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-frozen-verification-'));
  const orgId = 'org-a';
  const today = '2026-09-13';
  const oldestDay = '2025-09-14';
  const schema = sourceSchema('agent_message_facts');
  const source = (id: string, ingestedAt: string) => ({
    ...Object.fromEntries(
      schema.meta.map(({ name, type }) => [
        name,
        type.startsWith('DateTime')
          ? `${today} 01:00:00.000`
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
    EventAt: `${today} 01:00:00.000`,
    IngestedAt: ingestedAt,
    cost_usd: 1,
  });
  const exact = source('exact', `${today} 02:00:00.000`);
  const superseded = source('superseded', `${today} 02:00:00.000`);
  const currentSuperseded = { ...superseded, IngestedAt: `${today} 03:00:00.000`, cost_usd: 2 };
  const identities = [exact, superseded].map(
    (row) => `${orgId}\x1f${row.session_pk}\x1f${row.message_pk}`,
  );
  const expiredId = `${orgId}\x1fsession\x1fexpired`;
  const metadata = [exact, superseded].map((row, index) => ({
    category: 'messages' as const,
    factId: identities[index]!,
    sourceHash: stableHash(row),
    payloadBytes: Buffer.byteLength(JSON.stringify(row)),
    eventDay: today,
    ingestedAt: String(row.IngestedAt),
  }));
  metadata.push({
    category: 'messages',
    factId: expiredId,
    sourceHash: 'a'.repeat(16),
    payloadBytes: 100,
    eventDay: '2025-09-13',
    ingestedAt: `${oldestDay} 00:00:00.000`,
  });
  const recovery = {
    call: async (method: string, input: any) => {
      if (method === 'listFrozenFacts') {
        return {
          facts: metadata.map(({ category, factId }) => ({ category, factId })),
          nextAfter: null,
        };
      }
      if (method === 'inspectFrozenFactSources') return metadata;
      if (method === 'readFrozenFactSources') {
        return input.facts.map((fact: { factId: string }) => {
          const row = fact.factId === identities[0] ? exact : superseded;
          return {
            category: 'messages',
            factId: fact.factId,
            sourceHash: stableHash(row),
            payload: JSON.stringify(row),
          };
        });
      }
      throw new Error(`Unexpected recovery method ${method}`);
    },
  } as unknown as AgentRecoveryClient;
  const index = new CanonicalHashIndex(
    join(directory, 'canonical.sqlite'),
    orgId,
    'host',
    oldestDay,
    today,
  );
  try {
    index.saveSourceSchema('messages', schema);
    index.savePage(
      'messages',
      today,
      [exact, currentSuperseded].map((row, offset) => ({
        category: 'messages',
        factId: identities[offset]!,
        eventDay: today,
        deliverySequence: offset + 2,
        contentHash: String(offset + 1).repeat(64),
        ingestedAtMs: Date.parse(String(row.IngestedAt).replace(' ', 'T') + 'Z'),
        rowSha256: rowSha256(row, schema),
      })),
      'session',
      'superseded',
    );
    index.beginExport(3);
    index.finishExport(3);
    await expect(verifyAllFrozenFacts(recovery, index)).resolves.toMatchObject({
      total: 3,
      exactMatches: 1,
      safelySuperseded: 1,
      expired: 1,
      missing: 0,
      conflicts: 0,
      eligibleForLegacyRetirement: true,
    });
  } finally {
    index.close();
    rmSync(directory, { recursive: true });
  }
});

test('full frozen verification blocks retirement for missing and conflicting retained facts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-frozen-conflict-'));
  const orgId = 'org-a';
  const day = '2026-09-13';
  const schema = sourceSchema('agent_message_facts');
  const conflict = Object.fromEntries(
    schema.meta.map(({ name, type }) => [
      name,
      type.startsWith('DateTime')
        ? `${day} 01:00:00.000`
        : type.startsWith('Nullable')
          ? null
          : /Int|Float/.test(type)
            ? 0
            : 'value',
    ]),
  );
  Object.assign(conflict, {
    OrgId: orgId,
    session_pk: 'session',
    message_pk: 'conflict',
    EventAt: `${day} 01:00:00.000`,
    IngestedAt: `${day} 02:00:00.000`,
  });
  const conflictId = `${orgId}\x1fsession\x1fconflict`;
  const missingId = `${orgId}\x1fsession\x1fmissing`;
  const metadata = [conflictId, missingId].map((factId) => ({
    category: 'messages' as const,
    factId,
    sourceHash: factId === conflictId ? stableHash(conflict) : 'b'.repeat(16),
    payloadBytes: 100,
    eventDay: day,
    ingestedAt: `${day} 02:00:00.000`,
  }));
  const recovery = {
    call: async (method: string) => {
      if (method === 'listFrozenFacts') return { facts: metadata, nextAfter: null };
      if (method === 'inspectFrozenFactSources') return metadata;
      if (method === 'readFrozenFactSources') {
        return [
          {
            category: 'messages',
            factId: conflictId,
            sourceHash: stableHash(conflict),
            payload: JSON.stringify(conflict),
          },
        ];
      }
      throw new Error(`Unexpected recovery method ${method}`);
    },
  } as unknown as AgentRecoveryClient;
  const index = new CanonicalHashIndex(
    join(directory, 'canonical.sqlite'),
    orgId,
    'host',
    day,
    day,
  );
  try {
    index.saveSourceSchema('messages', schema);
    index.savePage(
      'messages',
      day,
      [
        {
          category: 'messages',
          factId: conflictId,
          eventDay: day,
          deliverySequence: 2,
          contentHash: 'c'.repeat(64),
          ingestedAtMs: Date.parse(`${day}T02:00:00.000Z`),
          rowSha256: 'd'.repeat(64),
        },
      ],
      'session',
      'conflict',
    );
    index.beginExport(2);
    index.finishExport(2);
    await expect(verifyAllFrozenFacts(recovery, index)).resolves.toMatchObject({
      total: 2,
      exactMatches: 0,
      safelySuperseded: 0,
      missing: 1,
      conflicts: 1,
      eligibleForLegacyRetirement: false,
    });
  } finally {
    index.close();
    rmSync(directory, { recursive: true });
  }
});

function sourceSchema(datasource: string): SourceSchema {
  const meta = [
    ...readFileSync(`datasources/${datasource}.datasource`, 'utf8').matchAll(
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
