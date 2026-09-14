import { describe, expect, test } from 'bun:test';
import type { AgentTinybirdClient } from './agent-transport';
import { verifyAgentSnapshotParity } from './agent-snapshot-parity';

function fakeTinybird(override?: (query: string, call: number) => Record<string, unknown>) {
  const queries: string[] = [];
  const client = {
    async sql(query: string) {
      queries.push(query);
      const data = override?.(query, queries.length) ?? {
        expected_count: 1,
        actual_count: 1,
        missing_actual: 0,
        unexpected_actual: 0,
      };
      return { data: [data], meta: [] };
    },
  } as unknown as AgentTinybirdClient;
  return { client, queries };
}

describe('verifyAgentSnapshotParity', () => {
  test('checks six identity indexes and all nine snapshot targets in both directions', async () => {
    const { client, queries } = fakeTinybird();
    await verifyAgentSnapshotParity(client, 'org-proof', {
      startDay: '2026-09-10',
      endDay: '2026-09-12',
    });

    expect(queries).toHaveLength(15);
    expect(queries.filter((query) => query.includes('agent_fact_identity_days'))).toHaveLength(6);
    expect(queries.filter((query) => query.includes('missing_actual'))).toHaveLength(15);
    expect(queries.every((query) => query.includes("'org-proof'"))).toBe(true);
    expect(queries.some((query) => query.includes('agent_session_signals_snapshots'))).toBe(true);
    const snapshotQueries = queries.slice(6);
    expect(snapshotQueries).toHaveLength(9);
    expect(snapshotQueries.every((query) => query.includes('_fact_versions FINAL'))).toBe(true);
    expect(snapshotQueries.every((query) => query.includes('AND IsDeleted = 0'))).toBe(true);
    for (const legacy of [
      'agent_message_facts',
      'agent_tool_event_facts',
      'agent_file_event_facts',
      'agent_capability_snapshot_facts',
      'agent_pull_request_facts',
      'agent_review_unit_attributions',
    ]) {
      expect(snapshotQueries.some((query) => query.includes(legacy))).toBe(false);
    }
  });

  test('fails closed when an identity index differs', async () => {
    const { client } = fakeTinybird((query, call) =>
      call === 1 && query.includes('agent_fact_identity_days')
        ? { expected_count: 1, actual_count: 1, missing_actual: 1, unexpected_actual: 0 }
        : { expected_count: 1, actual_count: 1, missing_actual: 0, unexpected_actual: 0 },
    );
    await expect(
      verifyAgentSnapshotParity(client, 'org-proof', {
        startDay: '2026-09-12',
        endDay: '2026-09-12',
      }),
    ).rejects.toThrow('Fact identity index mismatch');
  });

  test('rejects ranges beyond retained history before querying Tinybird', async () => {
    const { client, queries } = fakeTinybird();
    await expect(
      verifyAgentSnapshotParity(client, 'org-proof', {
        startDay: '2025-09-11',
        endDay: '2026-09-13',
      }),
    ).rejects.toThrow('exceeds retained history');
    expect(queries).toHaveLength(0);
  });

  test('checks retained history in bounded 31-day query chunks', async () => {
    const { client, queries } = fakeTinybird();
    await verifyAgentSnapshotParity(client, 'org-proof', {
      startDay: '2026-08-13',
      endDay: '2026-09-13',
    });

    expect(queries).toHaveLength(30);
    expect(queries.slice(0, 15).every((query) => !query.includes("'2026-09-13'"))).toBe(true);
    expect(queries.slice(15).every((query) => query.includes("'2026-09-13'"))).toBe(true);
  });
});
