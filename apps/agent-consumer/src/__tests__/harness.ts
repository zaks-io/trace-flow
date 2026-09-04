import { vi } from 'vitest';
import type { ModelPricing } from '@trace-flow/pricing';
import type { AgentIngestQueueMessage } from '@trace-flow/types';
import { insertRows } from '@trace-flow/tinybird-client';
import type { AgentConsumerEnv } from '../context';
import {
  CATEGORIES,
  DATASOURCES,
  LEGACY_CATEGORIES,
  LEGACY_DATASOURCES,
  type Accumulator,
} from '../facts';

const TINYBIRD_HOST = 'https://tb.test';

/** A stub Message exposing the ack/retry spies the consumer drives. */
interface StubMessage {
  id: string;
  body: unknown;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

export function stubMessage(body: unknown, id = 'm1'): StubMessage {
  return { id, body, ack: vi.fn(), retry: vi.fn() };
}

export function batchOf(messages: StubMessage[]): MessageBatch<AgentIngestQueueMessage> {
  return {
    queue: 'agent-ingest-dev',
    messages,
  } as unknown as MessageBatch<AgentIngestQueueMessage>;
}

/** KV stub whose `get` is a spy, so tests can assert read counts (one per distinct provider:model). */
export function makeKv(entries: Record<string, ModelPricing>): {
  kv: KVNamespace;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (key: string) => entries[key] ?? null);
  return { kv: { get } as unknown as KVNamespace, get };
}

export function makeEnv(
  kv: KVNamespace,
  overrides: Partial<Pick<AgentConsumerEnv, 'TINYBIRD_AGENT_WRITE_MODE'>> = {},
): AgentConsumerEnv {
  return {
    AGENT_QUEUE: {} as unknown as AgentConsumerEnv['AGENT_QUEUE'],
    MODEL_PRICING: kv,
    AGENT_FACT_BATCHER: makeFactBatcher(),
    TINYBIRD_TOKEN: 'tb-token',
    TINYBIRD_HOST,
    ...overrides,
  };
}

function makeFactBatcher(): AgentConsumerEnv['AGENT_FACT_BATCHER'] {
  return {
    getByName: () =>
      ({
        addFacts: async ({
          rows,
          writeClean = true,
          writeLegacy = false,
        }: {
          rows: Accumulator;
          writeClean?: boolean;
          writeLegacy?: boolean;
        }) => {
          try {
            let acceptedRows = 0;
            for (const category of CATEGORIES) {
              if (rows[category].length === 0) {
                continue;
              }
              acceptedRows += rows[category].length;
              if (writeClean) {
                await insertRows(rows[category], 'tb-token', DATASOURCES[category], TINYBIRD_HOST);
              }
              if (writeLegacy && LEGACY_CATEGORIES.includes(category as never)) {
                const legacyCategory = category as (typeof LEGACY_CATEGORIES)[number];
                await insertRows(
                  rows[legacyCategory],
                  'tb-token',
                  LEGACY_DATASOURCES[legacyCategory],
                  TINYBIRD_HOST,
                );
              }
            }
            return {
              status: 'accepted',
              acceptedRows,
              duplicateRows: 0,
              repairRows: 0,
              blockedRecoveryRows: 0,
              blockedRecoveryRecords: 0,
            };
          } catch {
            return {
              status: 'failed',
              acceptedRows: 0,
              duplicateRows: 0,
              repairRows: 0,
              blockedRecoveryRows: 0,
              blockedRecoveryRecords: 0,
            };
          }
        },
      }) as unknown,
  } as unknown as AgentConsumerEnv['AGENT_FACT_BATCHER'];
}

export interface CapturedInsert {
  datasource: string;
  rows: Record<string, unknown>[];
}

/**
 * Stubs `fetch` with a recorder for Tinybird inserts. Returns the captured POSTs and lets a test
 * force specific datasources to fail (so the insert-failure retry path is deterministic). `restore`
 * unstubs all globals — call it in `afterEach` so a throwing test never leaks the stub.
 */
export function mockTinybird(failDatasources: string[] = []): {
  inserts: CapturedInsert[];
  restore: () => void;
} {
  const inserts: CapturedInsert[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const datasource = new URL(String(url)).searchParams.get('name') ?? '';
      const body = String(init?.body ?? '');
      const rows = body
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      inserts.push({ datasource, rows });
      if (failDatasources.includes(datasource)) {
        return new Response('boom', { status: 503 });
      }
      return Response.json({ successful_rows: rows.length, quarantined_rows: 0 }, { status: 200 });
    }),
  );

  return {
    inserts,
    restore: () => {
      vi.unstubAllGlobals();
    },
  };
}
