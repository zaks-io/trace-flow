import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATEGORIES, DATASOURCES, type Category, type Row } from './agent-data';
import { exportCanonicalHashIndex } from './agent-canonical-export';
import {
  assertSameCanonicalFence,
  canonicalDeliveryFence,
  CanonicalHashIndex,
  type SourceSchema,
} from './agent-canonical-index';
import type { AgentTinybirdClient } from './agent-transport';

test('canonical export uses native day keysets and stores hashes without fact payloads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-canonical-index-'));
  const path = join(directory, 'canonical.sqlite');
  const orgId = 'org-a';
  const day = '2026-09-13';
  const schemas = Object.fromEntries(
    CATEGORIES.map((category) => [category, sourceSchema(DATASOURCES[category])]),
  ) as Record<Category, SourceSchema>;
  const secret = 'private-transcript-value';
  const message = sourceRow(schemas.messages, orgId, day, secret);
  const queries: string[] = [];
  const tb = {
    sql: async (query: string) => {
      queries.push(query);
      const schemaCategory = CATEGORIES.find(
        (category) => query === `SELECT * FROM ${DATASOURCES[category]} LIMIT 0`,
      );
      if (schemaCategory) return { data: [], meta: schemas[schemaCategory].meta };
      if (query.includes('FROM agent_message_fact_versions FINAL')) {
        return query.includes("tuple('session','message')")
          ? { data: [], meta: [] }
          : { data: [message], meta: [] };
      }
      if (query.includes('_versions FINAL')) return { data: [], meta: [] };
      throw new Error(`Unexpected Tinybird query ${query}`);
    },
  } as unknown as AgentTinybirdClient;
  const index = new CanonicalHashIndex(path, orgId, 'https://api.tinybird.co', day, day);
  try {
    index.beginExport(2);
    await exportCanonicalHashIndex(tb, index);
    index.finishExport(2);
    expect(index.get('messages', `${orgId}\x1fsession\x1fmessage`)).toMatchObject({
      eventDay: day,
      deliverySequence: 2,
      contentHash: 'a'.repeat(64),
    });
    expect(queries.filter((query) => query.includes('LIMIT 0'))).toHaveLength(CATEGORIES.length);
    const messageQuery = queries.find((query) => query.includes('agent_message_fact_versions'))!;
    expect(messageQuery).toContain(`OrgId='${orgId}' AND toDate(EventAt)=toDate('${day}')`);
    expect(messageQuery).toContain("tuple(session_pk,message_pk)>tuple('','')");
    expect(messageQuery).not.toContain('concat(');
  } finally {
    index.close();
  }
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  rmSync(directory, { recursive: true });
});

test('canonical export refuses to reuse an index across delivery fences', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-canonical-fence-'));
  const index = new CanonicalHashIndex(
    join(directory, 'canonical.sqlite'),
    'org-a',
    'host',
    '2026-09-13',
    '2026-09-13',
  );
  try {
    index.beginExport(4);
    expect(() => index.beginExport(5)).toThrow('became stale');
    expect(() => index.finishExport(5)).toThrow('delivery fence changed');
  } finally {
    index.close();
    rmSync(directory, { recursive: true });
  }
});

test('canonical delivery fence requires a completed quiescent migration and detects changes', () => {
  const state = {
    migration: { complete: true },
    coordinator: { activeDeliveries: 0, lastDeliverySequence: 42 },
  };
  expect(canonicalDeliveryFence(state)).toBe(42);
  expect(() =>
    canonicalDeliveryFence({
      ...state,
      coordinator: { ...state.coordinator, activeDeliveries: 1 },
    }),
  ).toThrow('quiescent');
  expect(() =>
    assertSameCanonicalFence(42, {
      ...state,
      coordinator: { ...state.coordinator, lastDeliverySequence: 43 },
    }),
  ).toThrow('changed during');
});

function sourceSchema(datasource: string): SourceSchema {
  const meta = [
    ...readFileSync(`datasources/${datasource}.datasource`, 'utf8').matchAll(
      /^\s+`([^`]+)`\s+([^\s,]+)/gm,
    ),
  ].map((match) => ({ name: match[1]!, type: match[2]! }));
  return { columns: meta.map(({ name }) => `\`${name}\``), meta };
}

function sourceRow(schema: SourceSchema, orgId: string, day: string, secret: string): Row {
  return {
    ...Object.fromEntries(
      schema.meta.map(({ name, type }) => [
        name,
        type.startsWith('DateTime')
          ? `${day} 01:00:00.000`
          : type.startsWith('Nullable')
            ? null
            : type.startsWith('Array')
              ? []
              : /Int|Float/.test(type)
                ? 0
                : secret,
      ]),
    ),
    OrgId: orgId,
    session_pk: 'session',
    message_pk: 'message',
    EventAt: `${day} 01:00:00.000`,
    IngestedAt: `${day} 02:00:00.000`,
    DeliverySequence: 2,
    ContentHash: 'a'.repeat(64),
  };
}
