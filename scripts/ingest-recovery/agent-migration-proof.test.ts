import { describe, expect, test } from 'bun:test';
import {
  inspectBaseline,
  intersectMigrationWindows,
  latestBaselineRows,
  migrationOrganizations,
  verifyBaseline,
  type BaselineCategoryProof,
} from './agent-migration-proof';
import { CATEGORIES, DATASOURCES } from './agent-data';
import { chunkAgentDayRange } from './agent-day-chunks';
import type { AgentTinybirdClient } from './agent-transport';

function fakeTinybird(rowsByCall: number[]) {
  const queries: string[] = [];
  const client = {
    async sql(query: string) {
      queries.push(query);
      const rows = rowsByCall[queries.length - 1] ?? 0;
      return {
        data: [
          query.includes('invalid_metadata')
            ? {
                source_rows: rows,
                target_rows: rows,
                invalid_metadata: 0,
                missing_target: 0,
                unexpected_target: 0,
              }
            : {
                source_rows: rows,
                target_rows: rows,
                missing_target: 0,
                unexpected_target: 0,
              },
        ],
        meta: [],
      };
    },
  } as unknown as AgentTinybirdClient;
  return { client, queries };
}

const messageProof = (rows: number): BaselineCategoryProof => ({
  category: 'messages',
  rows,
  days: [],
});

describe('migrationOrganizations', () => {
  test('covers every category in sequential bounded day chunks', async () => {
    const queries: string[] = [];
    let active = 0;
    let maxActive = 0;
    const client = {
      async sql(query: string) {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        queries.push(query);
        active--;
        return { data: [], meta: [] };
      },
    } as unknown as AgentTinybirdClient;
    const window = { startDay: '2026-08-13', endDay: '2026-09-13' };
    const chunks = chunkAgentDayRange(window);

    await expect(migrationOrganizations(client, window)).resolves.toEqual([]);

    expect(maxActive).toBe(1);
    expect(queries).toHaveLength(CATEGORIES.length * chunks.length);
    let call = 0;
    for (const category of CATEGORIES) {
      for (const chunk of chunks) {
        const query = queries[call++]!;
        const time = category === 'review_unit_attributions' ? 'DecidedAt' : 'EventAt';
        expect(query).toContain(`SELECT DISTINCT OrgId FROM ${DATASOURCES[category]}`);
        expect(query).toContain(`${time} >=`);
        expect(query).toContain(`toDateTime('${chunk.startDay}')`);
        expect(query).toContain(`toDateTime('${chunk.endDay}') + INTERVAL 1 DAY`);
        expect(query).toEndWith('LIMIT 1001');
        expect(query).not.toContain('UNION');
      }
    }
  });

  test('deduplicates organizations across categories and chunks and sorts the result', async () => {
    let call = 0;
    const client = {
      async sql() {
        const data = call++ === 0 ? [{ OrgId: 'org-z' }, { OrgId: 'org-a' }] : [{ OrgId: 'org-z' }];
        return { data, meta: [] };
      },
    } as unknown as AgentTinybirdClient;

    await expect(
      migrationOrganizations(client, { startDay: '2026-09-13', endDay: '2026-09-13' }),
    ).resolves.toEqual(['org-a', 'org-z']);
  });

  test('rejects a global organization union over 1000 across bounded queries', async () => {
    let call = 0;
    const client = {
      async sql() {
        const count = call++ === 0 ? 600 : 401;
        const offset = call === 1 ? 0 : 600;
        return {
          data: Array.from({ length: count }, (_, index) => ({ OrgId: `org-${offset + index}` })),
          meta: [],
        };
      },
    } as unknown as AgentTinybirdClient;

    await expect(
      migrationOrganizations(client, { startDay: '2026-08-13', endDay: '2026-09-13' }),
    ).rejects.toThrow(
      'Migration organization bound exceeded in messages for 2026-09-13 through 2026-09-13',
    );
  });

  test('rejects malformed organization ids with safe category and window context', async () => {
    const client = {
      async sql() {
        return { data: [null, { OrgId: 'org with spaces' }], meta: [] };
      },
    } as unknown as AgentTinybirdClient;

    await expect(
      migrationOrganizations(client, { startDay: '2026-09-13', endDay: '2026-09-13' }),
    ).rejects.toThrow(
      'Invalid migration organization in messages for 2026-09-13 through 2026-09-13',
    );
  });

  test('does not expose Tinybird errors while identifying the failed bounded query', async () => {
    const client = {
      async sql() {
        throw new Error('provider response containing secret-token');
      },
    } as unknown as AgentTinybirdClient;

    let message = '';
    try {
      await migrationOrganizations(client, {
        startDay: '2026-09-13',
        endDay: '2026-09-13',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'Migration organization discovery failed in messages for 2026-09-13 through 2026-09-13',
    );
    expect(message).not.toContain('secret-token');
  });
});

describe('latest baseline selection', () => {
  test('selects distinct latest rows using full-window maxima for a narrower output chunk', () => {
    const query = latestBaselineRows(
      'messages',
      'org-proof',
      { startDay: '2026-08-01', endDay: '2026-09-13' },
      { startDay: '2026-09-01', endDay: '2026-09-13' },
      'message_pk,EventAt,IngestedAt',
    );

    expect(query).toContain('SELECT DISTINCT message_pk,EventAt,IngestedAt');
    expect(query).toContain('tuple(OrgId,session_pk,message_pk,IngestedAt) IN');
    expect(query).toContain('SELECT OrgId,session_pk,message_pk,max(IngestedAt) AS IngestedAt');
    expect(query).toContain('GROUP BY OrgId,session_pk,message_pk');
    expect(query.match(/toDateTime\('2026-08-01'\)/g)).toHaveLength(2);
    expect(query.match(/toDateTime\('2026-09-01'\)/g)).toHaveLength(1);
  });

  test('inspects one latest row per identity after rejecting only conflicting equal-time rows', async () => {
    const queries: string[] = [];
    const client = {
      async sql(query: string) {
        queries.push(query);
        return query.includes('HAVING uniqExact')
          ? { data: [], meta: [] }
          : { data: [{ rows: '2', days: ['2026-09-12', '2026-09-13'] }], meta: [] };
      },
    } as unknown as AgentTinybirdClient;

    const proof = await inspectBaseline(client, 'org-proof', {
      startDay: '2026-09-12',
      endDay: '2026-09-13',
    });

    expect(proof).toEqual(
      CATEGORIES.map((category) => ({
        category,
        rows: 2,
        days: ['2026-09-12', '2026-09-13'],
      })),
    );
    expect(queries).toHaveLength(CATEGORIES.length * 2);
    const guards = queries.filter((query) => query.includes('HAVING uniqExact'));
    expect(guards).toHaveLength(CATEGORIES.length);
    expect(guards.every((query) => query.includes('GROUP BY OrgId,session_pk'))).toBe(true);
    expect(guards.every((query) => query.includes(',IngestedAt'))).toBe(true);
    const inspections = queries.filter((query) => query.includes('argMax('));
    expect(inspections).toHaveLength(CATEGORIES.length);
    expect(inspections.every((query) => query.includes('GROUP BY OrgId,session_pk'))).toBe(true);
  });

  test('fails before counting when full rows conflict at the same identity and ingestion time', async () => {
    const queries: string[] = [];
    const client = {
      async sql(query: string) {
        queries.push(query);
        return { data: [{ conflict: 1 }], meta: [] };
      },
    } as unknown as AgentTinybirdClient;

    await expect(
      inspectBaseline(client, 'org-proof', {
        startDay: '2026-09-12',
        endDay: '2026-09-13',
      }),
    ).rejects.toThrow('messages has conflicting equal-time versions');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('uniqExact(tuple(`OrgId`');
    expect(queries[0]).toContain('> 1');
    expect(queries[0]).toContain('LIMIT 1');
  });
});

describe('verifyBaseline', () => {
  test('keeps Copy arguments immutable while verification follows current retention', () => {
    expect(
      intersectMigrationWindows(
        { startDay: '2025-09-13', endDay: '2026-09-13' },
        { startDay: '2025-09-14', endDay: '2026-09-14' },
      ),
    ).toEqual({ startDay: '2025-09-14', endDay: '2026-09-13' });
  });

  test('checks content, metadata, and identity parity in bounded 31-day chunks', async () => {
    const { client, queries } = fakeTinybird([2, 2, 1, 1]);
    await verifyBaseline(
      client,
      'org-proof',
      { startDay: '2026-08-13', endDay: '2026-09-13' },
      messageProof(3),
    );

    expect(queries).toHaveLength(4);
    expect(queries.every((query) => query.includes('max(IngestedAt)'))).toBe(true);
    expect(queries.every((query) => query.includes("'2026-09-13'"))).toBe(true);
    expect(queries.slice(0, 2).every((query) => query.includes("'2026-09-12'"))).toBe(true);
    expect(queries.filter((query) => query.includes('EXCEPT DISTINCT'))).toHaveLength(4);
  });

  test('fails when bounded verification totals do not match the inspection proof', async () => {
    const { client } = fakeTinybird([0, 0]);
    await expect(
      verifyBaseline(
        client,
        'org-proof',
        { startDay: '2026-09-13', endDay: '2026-09-13' },
        messageProof(1),
      ),
    ).rejects.toThrow('does not match inspection proof');
  });
});
