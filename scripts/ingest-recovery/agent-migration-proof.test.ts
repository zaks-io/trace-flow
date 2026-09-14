import { describe, expect, test } from 'bun:test';
import {
  intersectMigrationWindows,
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
    expect(queries.slice(0, 2).every((query) => !query.includes("'2026-09-13'"))).toBe(true);
    expect(queries.slice(2).every((query) => query.includes("'2026-09-13'"))).toBe(true);
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
