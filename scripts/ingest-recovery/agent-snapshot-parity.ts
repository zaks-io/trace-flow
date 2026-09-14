import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { quote } from './agent-data';
import { chunkAgentDayRange, type AgentDayRange } from './agent-day-chunks';
import type { AgentTinybirdClient } from './agent-transport';

const REPO_ROOT = resolve(import.meta.dir, '../..');

const SNAPSHOTS = [
  'agent_context_call_buckets_hourly',
  'agent_repositories',
  'agent_session_file_signals',
  'agent_session_signals',
  'agent_session_summaries',
  'agent_tool_usage_daily',
  'agent_tool_usage_hourly',
  'agent_usage_daily',
  'agent_usage_hourly',
] as const;

const IDENTITY_INDEXES = [
  ['agent_message_fact_versions', 'messages', 'message_pk', 'EventAt'],
  ['agent_tool_event_fact_versions', 'tool_events', 'tool_use_pk', 'EventAt'],
  ['agent_file_event_fact_versions', 'file_events', 'file_event_pk', 'EventAt'],
  [
    'agent_capability_snapshot_fact_versions',
    'capability_snapshots',
    'capability_snapshot_pk',
    'EventAt',
  ],
  ['agent_pull_request_fact_versions', 'pull_request_links', 'pull_request_link_pk', 'EventAt'],
  [
    'agent_review_unit_attribution_versions',
    'review_unit_attributions',
    'review_unit_attribution_pk',
    'DecidedAt',
  ],
] as const;

interface Column {
  name: string;
  type: string;
}

export async function verifyAgentSnapshotParity(
  tinybird: AgentTinybirdClient,
  orgId: string,
  range: AgentDayRange,
): Promise<void> {
  if (!orgId) throw new Error('Snapshot parity requires an organization');
  for (const chunk of chunkAgentDayRange(range)) {
    await verifyIdentityIndexParity(tinybird, orgId, chunk);
    for (const snapshot of SNAPSHOTS) {
      const expected = expectedSnapshotQuery(snapshot, orgId, chunk.days);
      const actual = actualSnapshotQuery(snapshot, orgId, chunk);
      const columns = snapshotColumns(snapshot);
      const expectedProjection = parityProjection('expected', columns);
      const actualProjection = parityProjection('actual', columns);
      const proof = await tinybird.sql(`WITH expected AS (${expected}), actual AS (${actual})
        SELECT
          toUInt64((SELECT count() FROM expected)) AS expected_count,
          toUInt64((SELECT count() FROM actual)) AS actual_count,
          toUInt8((SELECT count() FROM (
            SELECT * FROM (
              SELECT ${expectedProjection} FROM expected
              EXCEPT
              SELECT ${actualProjection} FROM actual
            ) LIMIT 1
          )) > 0) AS missing_actual,
          toUInt8((SELECT count() FROM (
            SELECT * FROM (
              SELECT ${actualProjection} FROM actual
              EXCEPT
              SELECT ${expectedProjection} FROM expected
            ) LIMIT 1
          )) > 0) AS unexpected_actual`);
      const row = proof.data[0];
      const expectedCount = Number(row?.expected_count);
      const actualCount = Number(row?.actual_count);
      if (
        !Number.isSafeInteger(expectedCount) ||
        !Number.isSafeInteger(actualCount) ||
        expectedCount !== actualCount ||
        Number(row?.missing_actual) ||
        Number(row?.unexpected_actual)
      ) {
        throw new Error(
          `Snapshot parity failed in ${snapshot} for ${chunk.startDay} through ${chunk.endDay}`,
        );
      }
    }
  }
}

async function verifyIdentityIndexParity(
  tinybird: AgentTinybirdClient,
  orgId: string,
  range: AgentDayRange,
): Promise<void> {
  for (const [table, category, primaryKey, time] of IDENTITY_INDEXES) {
    const expected = `SELECT
      concat(OrgId,char(31),session_pk,char(31),${primaryKey}) AS FactIdentity,
      toDate(${time}) AS EventDay,
      DeliverySequence,
      ContentHash
      FROM ${table} FINAL
      WHERE OrgId=${quote(orgId)}
        AND toDate(${time})>=toDate(${quote(range.startDay)})
        AND toDate(${time})<=toDate(${quote(range.endDay)})
        AND IsDeleted=0`;
    const actual = `SELECT FactIdentity,EventDay,DeliverySequence,ContentHash
      FROM agent_fact_identity_days FINAL
      WHERE OrgId=${quote(orgId)}
        AND Category=${quote(category)}
        AND EventDay>=toDate(${quote(range.startDay)})
        AND EventDay<=toDate(${quote(range.endDay)})`;
    const proof = await tinybird.sql(`WITH expected AS (${expected}), actual AS (${actual})
      SELECT
        toUInt64((SELECT count() FROM expected)) AS expected_count,
        toUInt64((SELECT count() FROM actual)) AS actual_count,
        toUInt8((SELECT count() FROM (
          SELECT * FROM (
            SELECT * FROM expected
            EXCEPT
            SELECT * FROM actual
          ) LIMIT 1
        )) > 0) AS missing_actual,
        toUInt8((SELECT count() FROM (
          SELECT * FROM (
            SELECT * FROM actual
            EXCEPT
            SELECT * FROM expected
          ) LIMIT 1
        )) > 0) AS unexpected_actual`);
    const row = proof.data[0];
    if (
      !row ||
      Number(row.expected_count) !== Number(row.actual_count) ||
      Number(row.missing_actual) ||
      Number(row.unexpected_actual)
    ) {
      throw new Error(`Fact identity index mismatch for ${category}`);
    }
  }
}

function expectedSnapshotQuery(snapshot: string, orgId: string, days: string[]): string {
  const path = resolve(REPO_ROOT, 'copies', `repair_${snapshot}_snapshots.pipe`);
  const file = readFileSync(path, 'utf8');
  const match = /NODE snapshot\nSQL >\n\s+%\n([\s\S]+?)\n\nTYPE COPY/.exec(file);
  if (!match) throw new Error(`Cannot read snapshot query from ${path}`);
  const sql = match[1]!
    .replace(/^ {4}/gm, '')
    .replace(/\nSETTINGS max_threads = 1\s*$/, '')
    .replaceAll('{{ String(org_id) }}', quote(orgId))
    .replaceAll(
      "{{ Array(snapshot_days, 'Date') }}",
      `[${days.map((day) => `toDate(${quote(day)})`).join(',')}]`,
    )
    .replaceAll('{{ UInt64(snapshot_generation) }}', 'toUInt64(0)')
    .replaceAll('{{ UInt64(copy_attempt) }}', 'toUInt64(0)');
  if (/\{[{%]/.test(sql)) throw new Error(`Unrendered parameter in snapshot query ${snapshot}`);
  return sql;
}

function actualSnapshotQuery(snapshot: string, orgId: string, range: AgentDayRange): string {
  return `SELECT s.* FROM ${snapshot}_snapshots AS s FINAL
    INNER JOIN (
      SELECT SnapshotDay,max(SnapshotGeneration) AS SnapshotGeneration
      FROM agent_snapshot_manifest
      ARRAY JOIN SnapshotDays AS SnapshotDay
      WHERE OrgId=${quote(orgId)}
        AND SnapshotDay>=toDate(${quote(range.startDay)})
        AND SnapshotDay<=toDate(${quote(range.endDay)})
      GROUP BY SnapshotDay
    ) AS manifest USING (SnapshotDay,SnapshotGeneration)
    WHERE s.OrgId=${quote(orgId)}
      AND s.SnapshotDay>=toDate(${quote(range.startDay)})
      AND s.SnapshotDay<=toDate(${quote(range.endDay)})`;
}

function snapshotColumns(snapshot: string): Column[] {
  const path = resolve(REPO_ROOT, 'datasources', `${snapshot}_snapshots.datasource`);
  const file = readFileSync(path, 'utf8');
  const schema = /SCHEMA >\n([\s\S]+?)\n\nENGINE /.exec(file)?.[1];
  if (!schema) throw new Error(`Cannot read snapshot schema from ${path}`);
  const columns = [...schema.matchAll(/^\s*`([^`]+)`\s+(.+?)(?:,)?$/gm)]
    .map((match) => ({ name: match[1]!, type: match[2]!.replace(/,$/, '') }))
    .filter(({ name }) => !['SnapshotGeneration', 'CopyAttempt'].includes(name));
  if (!columns.length) throw new Error(`Snapshot schema is empty in ${path}`);
  return columns;
}

function parityProjection(source: string, columns: Column[]): string {
  return columns
    .map(({ name, type }, index) => {
      const column = `${source}.\`${name}\``;
      const finalized = type.startsWith('AggregateFunction(')
        ? type.includes('Float64')
          ? `round(finalizeAggregation(${column}),9)`
          : `finalizeAggregation(${column})`
        : column;
      return `${finalized} AS c${index}`;
    })
    .join(',');
}
