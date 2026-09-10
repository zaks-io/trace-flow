import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSnapshot,
  DATASOURCES,
  batches,
  factBatches,
  identity,
  stableHash,
} from './agent-data';
import { normalized, AgentTinybirdClient } from './agent-transport';
import { RebuildJournal, rebuild, reconcileDeleteJob, verifyFacts } from './agent-rebuild';
import { confirmExistingInsert } from './agent-insert-proof';
import { assertRollupRows } from './agent-rollup-proof';

const opened: AgentSnapshot[] = [];
afterEach(() => {
  for (const snapshot of opened.splice(0)) snapshot.db.close();
});
const row = {
  OrgId: 'org-a',
  session_pk: 'session',
  message_pk: 'message',
  IngestedAt: '2026-09-10 10:00:00.000',
  EventAt: '2026-09-10 10:00:00.000',
  output_tokens: 1,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-rebuild-test-'));
  const snapshot = new AgentSnapshot(join(dir, 'snapshot.sqlite'), true);
  opened.push(snapshot);
  snapshot.meta('org', 'org-a');
  snapshot.meta('operationId', 'op-1');
  snapshot.meta('graph', { facts: [DATASOURCES.messages], derived: ['agent_usage_daily'] });
  return { dir, snapshot };
}

describe('agent fact rebuild snapshot', () => {
  test('preserves physical duplicates but rebuilds one corrected identity', () => {
    const { snapshot } = fixture();
    snapshot.preserve('messages', DATASOURCES.messages, row, 'org-a');
    snapshot.preserve('messages', DATASOURCES.messages, row, 'org-a');
    const key = identity('messages', row, 'org-a');
    snapshot.overlay(
      'messages',
      key,
      JSON.stringify({ ...row, output_tokens: 42 }),
      stableHash(row),
      'org-a',
    );
    expect(snapshot.db.query('SELECT count(*) AS count FROM originals').get()).toEqual({
      count: 2,
    });
    expect([...snapshot.rows('messages')]).toHaveLength(1);
    expect(JSON.parse(snapshot.get('messages', key)!.data).output_tokens).toBe(42);
    expect(snapshot.get('messages', key)!.old_hash).toBe(stableHash(row));
  });
  test('retains legacy coverage without mirroring every canonical identity into legacy', () => {
    const { snapshot } = fixture();
    snapshot.preserve('messages', 'agent_messages', row, 'org-a');
    snapshot.preserve('messages', DATASOURCES.messages, { ...row, message_pk: 'new' }, 'org-a');
    expect([...snapshot.rows('messages')]).toHaveLength(2);
    expect([...snapshot.rows('messages', 'agent_messages')]).toHaveLength(1);
  });
  test('rejects cross-organization and conflicting equal-time payloads', () => {
    const { snapshot } = fixture();
    expect(() => snapshot.preserve('messages', DATASOURCES.messages, row, 'org-b')).toThrow();
    snapshot.preserve('messages', DATASOURCES.messages, row, 'org-a');
    expect(() =>
      snapshot.preserve('messages', DATASOURCES.messages, { ...row, output_tokens: 2 }, 'org-a'),
    ).toThrow('Conflicting');
  });
  test('bounds serialized work by bytes and rows without truncating a row', () => {
    expect([...batches(['é'.repeat(5), 'é'.repeat(5)], 20)]).toHaveLength(2);
    expect([...batches([1, 2, 3], 100, 2)]).toEqual([[1, 2], [3]]);
    expect([...batches(['x'.repeat(100), 'small'], 20)]).toEqual([['x'.repeat(100)], ['small']]);
  });
  test('bounds fact uploads to 30 daily partitions while preserving order', () => {
    const dates = Array.from({ length: 31 }, (_, index) =>
      new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    );
    const rows = [...dates.slice(0, 30), dates[0]!, dates[30]!].map((EventAt, index) => ({
      ...row,
      message_pk: `message-${index}`,
      EventAt,
    }));
    const groups = [...factBatches('messages', rows)];

    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(31);
    expect(groups.flat()).toEqual(rows);
    for (const group of groups) {
      expect(
        new Set(group.map((fact) => String(fact.EventAt).slice(0, 10))).size,
      ).toBeLessThanOrEqual(30);
    }
  });
  test('normalizes storage representation without inventing absent values', () => {
    expect(
      normalized({ n: 123, t: '2026-09-10 10:00:00.000' }, [
        { name: 'n', type: 'UInt64' },
        { name: 't', type: 'DateTime64(3)' },
      ]),
    ).toEqual({ n: '123', t: '2026-09-10T10:00:00.000Z' });
    expect(() => normalized({}, [{ name: 'n', type: 'UInt64' }])).toThrow('missing stored column');
  });
});

test('journal persists uncertain writes and rejects another operation', async () => {
  const { snapshot, dir } = fixture();
  snapshot.preserve('messages', DATASOURCES.messages, row, 'org-a');
  const path = join(dir, 'journal.json');
  let requests = 0;
  const tinybird = {
    request: async () => {
      requests++;
      throw new Error('timeout after submission');
    },
  };
  const recovery = { org: 'org-a', call: async () => ({ status: 'quiescent' }) };
  await expect(
    rebuild(
      snapshot,
      tinybird as any,
      recovery as any,
      new RebuildJournal(path, 'op-1'),
      'test',
      'a'.repeat(64),
    ),
  ).rejects.toThrow('timeout');
  await expect(
    rebuild(
      snapshot,
      tinybird as any,
      recovery as any,
      new RebuildJournal(path, 'op-1'),
      'test',
      'a'.repeat(64),
    ),
  ).rejects.toThrow('Uncertain delete');
  expect(requests).toBe(1);
  expect(() => new RebuildJournal(path, 'op-2')).toThrow('another operation');
});

test('reconciles an uncertain delete only to its matching Tinybird job receipt', async () => {
  const { dir } = fixture();
  const journal = new RebuildJournal(join(dir, 'reconcile-journal.json'), 'op-1');
  const startedAtMs = Date.parse('2026-09-10T19:46:34.500Z');
  journal.set('delete:agent_message_facts', { status: 'started', startedAtMs });
  const tinybird = {
    request: async () => ({
      kind: 'delete_data',
      id: 'job-123',
      job_id: 'job-123',
      status: 'working',
      created_at: '2026-09-10 19:46:34.157386',
      datasource: { id: 'datasource-id', name: 'agent_message_facts' },
      delete_condition: " OrgId = 'org-a'",
    }),
  };

  await reconcileDeleteJob(tinybird as any, journal, 'org-a', 'agent_message_facts', 'job-123');

  expect(journal.get('delete:agent_message_facts')).toEqual({
    status: 'started',
    startedAtMs,
    jobId: 'job-123',
  });
});

test('rejects a stale or mismatched delete receipt without changing the journal', async () => {
  const { dir } = fixture();
  const journal = new RebuildJournal(join(dir, 'rejected-journal.json'), 'op-1');
  const startedAtMs = Date.parse('2026-09-10T19:46:34.500Z');
  journal.set('delete:agent_message_facts', { status: 'started', startedAtMs });
  const result = {
    kind: 'delete_data',
    id: 'job-123',
    job_id: 'job-123',
    status: 'done',
    created_at: '2026-09-10 19:46:30.000000',
    datasource: { id: 'datasource-id', name: 'agent_message_facts' },
    delete_condition: "OrgId = 'org-b'",
  };

  await expect(
    reconcileDeleteJob(
      { request: async () => result } as any,
      journal,
      'org-a',
      'agent_message_facts',
      'job-123',
    ),
  ).rejects.toThrow('does not match');
  expect(journal.get('delete:agent_message_facts')).toEqual({ status: 'started', startedAtMs });

  await expect(
    reconcileDeleteJob(
      {
        request: async () => ({
          ...result,
          created_at: 'invalid',
          delete_condition: "OrgId = 'org-a'",
        }),
      } as any,
      journal,
      'org-a',
      'agent_message_facts',
      'job-123',
    ),
  ).rejects.toThrow('does not match');
});

test('verification catches duplicates, missing facts, and every wrong stored value', async () => {
  const { snapshot } = fixture();
  snapshot.preserve('messages', DATASOURCES.messages, row, 'org-a');
  let stored = [row];
  const tinybird = {
    sql: async () => ({ meta: Object.keys(row).map((name) => ({ name, type: 'String' })) }),
    rows: async function* () {
      yield* stored;
    },
  };
  await expect(verifyFacts(snapshot, tinybird as any)).resolves.toHaveLength(64);
  stored = [row, row];
  await expect(verifyFacts(snapshot, tinybird as any)).rejects.toThrow('Duplicate');
  stored = [];
  await expect(verifyFacts(snapshot, tinybird as any)).rejects.toThrow('count mismatch');
  stored = [{ ...row, output_tokens: 2 }];
  await expect(verifyFacts(snapshot, tinybird as any)).rejects.toThrow('Stored fact mismatch');
  stored = [{ ...row, IngestedAt: '2026-09-10 10:00:09.999' }];
  await expect(verifyFacts(snapshot, tinybird as any)).rejects.toThrow('Stored fact mismatch');
});

test('uncertain insert reconciliation requires an exact stored timestamp', async () => {
  const tinybird = {
    sql: async () => ({
      data: [{ ...row, IngestedAt: '2026-09-10 10:00:09.999' }],
      meta: Object.keys(row).map((name) => ({ name, type: 'String' })),
    }),
  };
  await expect(
    confirmExistingInsert(
      tinybird as any,
      DATASOURCES.messages,
      'org-a',
      ['OrgId', 'session_pk', 'message_pk'],
      [row],
    ),
  ).resolves.toBe(false);
});

test('rollup comparison keeps UInt64 values above the safe integer limit distinct', () => {
  expect(() =>
    assertRollupRows(
      [{ EventCount: '9007199254740992' }],
      [{ EventCount: '9007199254740993' }],
      'agent_tool_usage_daily',
    ),
  ).toThrow('Rollup values mismatch');
});

test('snapshot pagination retains duplicate identities at a page boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-transport-test-'));
  const config = join(dir, 'tinyb.json');
  writeFileSync(config, JSON.stringify({ host: 'http://localhost:7181', token: 'test' }), {
    mode: 0o600,
  });
  const client = new AgentTinybirdClient(config);
  const queries: string[] = [];
  client.sql = async (query) => {
    queries.push(query);
    if (queries.length === 1) return { data: [row], meta: [] };
    if (queries.length === 2) return { data: [row, row], meta: [] };
    return { data: [], meta: [] };
  };
  const result = [];
  for await (const item of client.rows(DATASOURCES.messages, 'org-a', [
    'OrgId',
    'session_pk',
    'message_pk',
  ]))
    result.push(item);
  expect(result).toEqual([row, row]);
  expect(queries[2]).toContain(
    "tuple(OrgId,session_pk,message_pk)>tuple('org-a','session','message')",
  );
});
