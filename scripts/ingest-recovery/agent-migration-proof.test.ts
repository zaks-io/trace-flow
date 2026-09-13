import { describe, expect, test } from 'bun:test';
import {
  intersectMigrationWindows,
  verifyBaseline,
  type BaselineCategoryProof,
} from './agent-migration-proof';
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
