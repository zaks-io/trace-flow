import { describe, expect, it } from 'vitest';
import { AgentFactMaintenance } from '../fact-maintenance';

const executorId = '11111111-1111-4111-8111-111111111111';

describe('fact maintenance pagination', () => {
  it('loads only the payloads needed to reach the response byte limit', () => {
    const factIds = Array.from(
      { length: 101 },
      (_, index) => `fact-${index.toString().padStart(3, '0')}`,
    );
    const queries: string[] = [];
    const storage = {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          queries.push(query);
          if (query.includes('SELECT * FROM fact_rebuild_operations')) {
            return [
              {
                operation_id: 'op-1',
                executor_id: executorId,
                state: 'active',
              },
            ];
          }
          if (query.includes('SELECT category, fact_id, content_hash')) {
            return factIds.map((factId) => ({
              category: 'messages',
              fact_id: factId,
              content_hash: 'hash',
            }));
          }
          if (query.includes("SELECT COALESCE(data, '') AS data FROM fact_ledger")) {
            expect(factIds).toContain(String(bindings[1]));
            return [{ data: 'x'.repeat(890_000) }];
          }
          if (query.includes('SELECT id, content_hash, data FROM')) return [];
          throw new Error(`Unexpected query: ${query}`);
        },
      },
    };
    const maintenance = new AgentFactMaintenance(storage as never, {} as never);

    const page = maintenance.list({ operationId: 'op-1', executorId, limit: 100 });

    expect(page.facts).toHaveLength(1);
    expect(page.nextAfter).toEqual({ category: 'messages', factId: 'fact-000' });
    expect(
      queries.filter((query) =>
        query.includes("SELECT COALESCE(data, '') AS data FROM fact_ledger"),
      ),
    ).toHaveLength(2);
    expect(
      queries.find((query) => query.includes('SELECT category, fact_id, content_hash')),
    ).not.toContain("COALESCE(data, '')");
  });
});
