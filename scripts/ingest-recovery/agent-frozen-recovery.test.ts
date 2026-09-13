import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentAnalyticsDayBounds } from '../../packages/utils/src/agent-retention';
import { FrozenRecoveryJournal } from './agent-frozen-journal';
import {
  inspectMissingCensus,
  missingCensusPages,
  recoverReadyFacts,
} from './agent-frozen-recovery';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';

const opened: FrozenRecoveryJournal[] = [];
afterEach(() => {
  for (const journal of opened.splice(0)) journal.close();
});

function createCensus(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    CREATE TABLE initial_missing(category TEXT,source TEXT,session_pk TEXT,pk TEXT,
      PRIMARY KEY(category,source,session_pk,pk)) WITHOUT ROWID;
    CREATE TABLE current_found(category TEXT,source TEXT,session_pk TEXT,pk TEXT,store TEXT,
      PRIMARY KEY(category,source,session_pk,pk,store)) WITHOUT ROWID;
  `);
  for (const pk of [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
  ]) {
    db.query('INSERT INTO initial_missing VALUES(?,?,?,?)').run(
      'messages',
      'cursor',
      '20000000-0000-4000-8000-000000000001',
      pk,
    );
  }
  db.query('INSERT INTO current_found VALUES(?,?,?,?,?)').run(
    'messages',
    'cursor',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003',
    'canonical',
  );
  db.close();
}

function emptyTinybird(rows: Record<string, unknown>[] = []) {
  return {
    sql: async () => ({ data: rows, meta: [] }),
  } as unknown as AgentTinybirdClient;
}

describe('frozen census recovery', () => {
  test('reads the actual census schema and separates missing frozen sources from conflicts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'frozen-census-'));
    const census = join(directory, 'census.sqlite');
    createCensus(census);
    const orgId = 'org-a';
    const pages = [...missingCensusPages(census, orgId)];
    expect(pages.flat()).toHaveLength(2);
    const journal = new FrozenRecoveryJournal(
      join(directory, 'journal.sqlite'),
      orgId,
      'a'.repeat(64),
    );
    opened.push(journal);
    const day = agentAnalyticsDayBounds(Date.now()).today;
    const recovery = {
      call: async (
        method: string,
        input: { facts: Array<{ category: string; factId: string }> },
      ) => {
        expect(method).toBe('inspectFrozenFactSources');
        return [
          {
            ...input.facts[0],
            sourceHash: 'b'.repeat(16),
            payloadBytes: 100,
            eventDay: day,
            ingestedAt: `${day} 01:00:00.000`,
          },
        ];
      },
    } as unknown as AgentRecoveryClient;
    await inspectMissingCensus(
      census,
      orgId,
      recovery,
      journal,
      emptyTinybird([
        {
          FactIdentity: `${orgId}\x1f20000000-0000-4000-8000-000000000001\x1f10000000-0000-4000-8000-000000000001`,
          EventDay: day,
          DeliverySequence: 2,
          ContentHash: 'c'.repeat(64),
        },
      ]),
    );
    expect(journal.report()).toEqual({
      total: 2,
      ready: 0,
      missing: 1,
      conflict: 1,
      expired: 0,
      confirmed: 0,
    });
  });

  test('reuses the same durable delivery ID and creation time after an uncertain replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'frozen-restart-'));
    const path = join(directory, 'journal.sqlite');
    const orgId = 'org-a';
    const day = agentAnalyticsDayBounds(Date.now()).today;
    let journal = new FrozenRecoveryJournal(path, orgId, 'a'.repeat(64));
    journal.recordInspection(
      [{ category: 'messages', factId: `${orgId}\x1fsession\x1ffact` }],
      [
        {
          category: 'messages',
          factId: `${orgId}\x1fsession\x1ffact`,
          sourceHash: 'b'.repeat(16),
          payloadBytes: 100,
          eventDay: day,
          ingestedAt: `${day} 01:00:00.000`,
        },
      ],
      agentAnalyticsDayBounds(Date.now()).oldestDay,
    );
    const calls: unknown[] = [];
    const uncertain = {
      call: async (_method: string, input: unknown) => {
        calls.push(input);
        throw new Error('response lost');
      },
    } as unknown as AgentRecoveryClient;
    await expect(recoverReadyFacts(uncertain, journal, emptyTinybird(), orgId)).rejects.toThrow(
      'response lost',
    );
    journal.close();

    journal = new FrozenRecoveryJournal(path, orgId, 'a'.repeat(64));
    opened.push(journal);
    const confirmed = {
      call: async (_method: string, input: any) => {
        calls.push(input);
        return {
          status: 'confirmed',
          deliveryId: input.deliveryId,
          deliverySequence: 2,
          factCount: input.facts.length,
        };
      },
    } as unknown as AgentRecoveryClient;
    await recoverReadyFacts(confirmed, journal, emptyTinybird(), orgId);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(journal.report().confirmed).toBe(1);
  });
});
