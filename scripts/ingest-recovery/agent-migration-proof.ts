import { agentAnalyticsDayBounds } from '../../packages/utils/src/agent-retention';
import { readFileSync } from 'node:fs';
import { CATEGORIES, DATASOURCES, ROW_IDENTITY_FIELDS, quote, type Category } from './agent-data';
import { chunkAgentDayRange } from './agent-day-chunks';
import type { AgentTinybirdClient } from './agent-transport';
import { FACT_VERSION_DATASOURCES } from '../../apps/agent-consumer/src/delivery-write';

export const MIGRATION_ID = 'bounded-agent-ingestion-v1';
export interface BaselineCategoryProof {
  category: Category;
  rows: number;
  days: string[];
  dailyStats: { day: string; rows: number; projectedBytes: number }[];
}
export interface MigrationWindow {
  startDay: string;
  endDay: string;
}

export function retainedMigrationWindow(now = Date.now()): MigrationWindow {
  const { oldestDay, today } = agentAnalyticsDayBounds(now);
  return { startDay: oldestDay, endDay: today };
}

export function intersectMigrationWindows(
  baseline: MigrationWindow,
  retained: MigrationWindow,
): MigrationWindow {
  const window = {
    startDay: baseline.startDay > retained.startDay ? baseline.startDay : retained.startDay,
    endDay: baseline.endDay < retained.endDay ? baseline.endDay : retained.endDay,
  };
  if (window.startDay > window.endDay) {
    throw new Error('Baseline Copy window no longer overlaps analytics retention');
  }
  return window;
}

export function migrationScope(category: Category, org: string, window: MigrationWindow): string {
  const time = category === 'review_unit_attributions' ? 'DecidedAt' : 'EventAt';
  return `OrgId = ${quote(org)} AND ${time} >= toDateTime(${quote(window.startDay)}) AND ${time} < toDateTime(${quote(window.endDay)}) + INTERVAL 1 DAY`;
}

export function latestBaselineRows(
  category: Category,
  org: string,
  fullWindow: MigrationWindow,
  outerChunk?: MigrationWindow,
  projection = '*',
): string {
  const source = DATASOURCES[category];
  const identity = ROW_IDENTITY_FIELDS[category].join(',');
  const latestIdentity = [...ROW_IDENTITY_FIELDS[category], 'IngestedAt'].join(',');
  const outerScopes = [migrationScope(category, org, fullWindow)];
  if (outerChunk) outerScopes.push(migrationScope(category, org, outerChunk));
  return `SELECT DISTINCT ${projection} FROM ${source}
    WHERE ${outerScopes.join(' AND ')}
      AND tuple(${latestIdentity}) IN (
        SELECT ${identity},max(IngestedAt) AS IngestedAt
        FROM ${source}
        WHERE ${migrationScope(category, org, fullWindow)}
        GROUP BY ${identity}
      )`;
}

export async function migrationOrganizations(
  tb: AgentTinybirdClient,
  window: MigrationWindow,
): Promise<string[]> {
  const organizations = new Set<string>();
  const chunks = chunkAgentDayRange(window);
  for (const category of CATEGORIES) {
    for (const chunk of chunks) {
      const context = `${category} for ${chunk.startDay} through ${chunk.endDay}`;
      let rows: unknown;
      try {
        rows = (
          await tb.sql(
            `SELECT DISTINCT OrgId FROM ${DATASOURCES[category]} WHERE ${migrationScope(category, '', chunk).replace("OrgId = '' AND ", '')} LIMIT 1001`,
          )
        ).data;
      } catch {
        throw new Error(`Migration organization discovery failed in ${context}`);
      }
      if (!Array.isArray(rows)) {
        throw new Error(`Invalid migration organization response in ${context}`);
      }
      for (const row of rows) {
        const orgId =
          row && typeof row === 'object' ? (row as Record<string, unknown>).OrgId : undefined;
        if (typeof orgId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(orgId)) {
          throw new Error(`Invalid migration organization in ${context}`);
        }
        organizations.add(orgId);
        if (organizations.size > 1000) {
          throw new Error(
            `Migration organization bound exceeded in ${context}; use paginated migration before proceeding`,
          );
        }
      }
    }
  }
  return [...organizations].sort();
}

export async function inspectBaseline(
  tb: AgentTinybirdClient,
  org: string,
  window: MigrationWindow,
  copyWindow: MigrationWindow,
): Promise<BaselineCategoryProof[]> {
  const proofs: BaselineCategoryProof[] = [];
  for (const category of CATEGORIES) {
    const time = category === 'review_unit_attributions' ? 'DecidedAt' : 'EventAt';
    const identity = ROW_IDENTITY_FIELDS[category].join(',');
    const projection = baselineProjection(category);
    const conflicts = (
      await tb.sql(`SELECT 1 FROM ${DATASOURCES[category]}
        WHERE ${migrationScope(category, org, copyWindow)}
        GROUP BY ${identity},IngestedAt
        HAVING uniqExact(tuple(${projection})) > 1
        LIMIT 1`)
    ).data;
    if (!Array.isArray(conflicts) || conflicts.length > 0) {
      throw new Error(
        `Source ${category} has conflicting equal-time versions; baseline requires repair`,
      );
    }
    const rows = (
      await tb.sql(`SELECT toString(toDate(latest_time)) AS day,
        count() AS rows,
        sum(latest_projected_bytes) AS projected_bytes
        FROM (
          SELECT argMax(${time},IngestedAt) AS latest_time,
            argMax(length(toJSONString(tuple(${projection}))),IngestedAt) AS latest_projected_bytes
          FROM ${DATASOURCES[category]}
          WHERE ${migrationScope(category, org, copyWindow)}
          GROUP BY ${identity}
        ) WHERE latest_time >= toDateTime(${quote(window.startDay)})
          AND latest_time < toDateTime(${quote(window.endDay)}) + INTERVAL 1 DAY
        GROUP BY day ORDER BY day`)
    ).data;
    if (!Array.isArray(rows) || rows.length > 367) {
      throw new Error(`Source ${category} is not uniquely defined; baseline requires repair`);
    }
    const dailyStats = rows.map((row) => ({
      day: String(row.day),
      rows: safeCount(row.rows, `${category} daily rows`),
      projectedBytes: safeCount(row.projected_bytes, `${category} daily projected bytes`),
    }));
    if (
      dailyStats.some(
        (row) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(row.day) ||
          !Number.isSafeInteger(row.rows) ||
          row.rows <= 0 ||
          !Number.isSafeInteger(row.projectedBytes) ||
          row.projectedBytes <= 0,
      )
    ) {
      throw new Error(`Source ${category} is not uniquely defined; baseline requires repair`);
    }
    proofs.push({
      category,
      rows: dailyStats.reduce((sum, row) => sum + row.rows, 0),
      days: dailyStats.map((row) => row.day),
      dailyStats,
    });
  }
  return proofs;
}

export async function verifyBaseline(
  tb: AgentTinybirdClient,
  org: string,
  window: MigrationWindow,
  proof: BaselineCategoryProof,
  copyWindow: MigrationWindow,
): Promise<void> {
  const { category } = proof;
  const target = FACT_VERSION_DATASOURCES[category];
  const projection = baselineProjection(category);
  const time = category === 'review_unit_attributions' ? 'DecidedAt' : 'EventAt';
  const identity = `concat(${ROW_IDENTITY_FIELDS[category].join(', char(31), ')})`;
  let verifiedSourceRows = 0;
  let verifiedTargetRows = 0;
  let verifiedSourceIndexRows = 0;
  let verifiedTargetIndexRows = 0;

  for (const chunk of chunkAgentDayRange(window)) {
    const scope = migrationScope(category, org, chunk);
    const sourceRows = latestBaselineRows(category, org, copyWindow, chunk, projection);
    const content = (
      await tb.sql(`WITH
        source_rows AS (
          ${sourceRows}
        ),
        target_rows AS (
          SELECT ${projection}, DeliverySequence, ContentHash, IsDeleted
          FROM ${target} FINAL
          WHERE ${scope} AND IsDeleted = 0
        )
        SELECT
          toUInt64((SELECT count() FROM source_rows)) AS source_rows,
          toUInt64((SELECT count() FROM target_rows)) AS target_rows,
          toUInt64((SELECT countIf(DeliverySequence != 1 OR IsDeleted != 0 OR ContentHash != lower(hex(SHA256(toJSONString(tuple(${projection})))))) FROM target_rows)) AS invalid_metadata,
          toUInt8((SELECT count() FROM (
            SELECT * FROM (
              SELECT ${projection} FROM source_rows
              EXCEPT DISTINCT
              SELECT ${projection} FROM target_rows
            ) LIMIT 1
          )) > 0) AS missing_target,
          toUInt8((SELECT count() FROM (
            SELECT * FROM (
              SELECT ${projection} FROM target_rows
              EXCEPT DISTINCT
              SELECT ${projection} FROM source_rows
            ) LIMIT 1
          )) > 0) AS unexpected_target`)
    ).data[0];
    const sourceRowCount = safeCount(content?.source_rows, `${category} source rows`);
    const targetRows = safeCount(content?.target_rows, `${category} target rows`);
    if (
      sourceRowCount !== targetRows ||
      safeCount(content?.invalid_metadata, `${category} invalid metadata`) !== 0 ||
      Number(content?.missing_target) ||
      Number(content?.unexpected_target)
    ) {
      throw new Error(
        `Exact ${category} baseline parity failed for ${chunk.startDay} through ${chunk.endDay}`,
      );
    }
    verifiedSourceRows += sourceRowCount;
    verifiedTargetRows += targetRows;

    const sourceIndex = latestBaselineRows(
      category,
      org,
      copyWindow,
      chunk,
      `${identity} AS FactIdentity, toDate(${time}) AS EventDay`,
    );
    const targetIndex = `SELECT FactIdentity, EventDay FROM agent_fact_identity_days FINAL WHERE OrgId=${quote(org)} AND Category=${quote(category)} AND DeliverySequence=1 AND EventDay>=toDate(${quote(chunk.startDay)}) AND EventDay<=toDate(${quote(chunk.endDay)})`;
    const index = (
      await tb.sql(`WITH
        source_index AS (${sourceIndex}),
        target_index AS (${targetIndex})
        SELECT
          toUInt64((SELECT count() FROM source_index)) AS source_rows,
          toUInt64((SELECT count() FROM target_index)) AS target_rows,
          toUInt8((SELECT count() FROM (
            SELECT * FROM (
              SELECT * FROM source_index
              EXCEPT DISTINCT
              SELECT * FROM target_index
            ) LIMIT 1
          )) > 0) AS missing_target,
          toUInt8((SELECT count() FROM (
            SELECT * FROM (
              SELECT * FROM target_index
              EXCEPT DISTINCT
              SELECT * FROM source_index
            ) LIMIT 1
          )) > 0) AS unexpected_target`)
    ).data[0];
    const sourceIndexRows = safeCount(index?.source_rows, `${category} source identity rows`);
    const targetIndexRows = safeCount(index?.target_rows, `${category} target identity rows`);
    if (
      sourceIndexRows !== targetIndexRows ||
      Number(index?.missing_target) ||
      Number(index?.unexpected_target)
    ) {
      throw new Error(
        `Exact ${category} identity-day parity failed for ${chunk.startDay} through ${chunk.endDay}`,
      );
    }
    verifiedSourceIndexRows += sourceIndexRows;
    verifiedTargetIndexRows += targetIndexRows;
  }

  if (
    verifiedSourceRows !== proof.rows ||
    verifiedTargetRows !== proof.rows ||
    verifiedSourceIndexRows !== proof.rows ||
    verifiedTargetIndexRows !== proof.rows
  ) {
    throw new Error(`Verified ${category} baseline row count does not match inspection proof`);
  }
}

function safeCount(value: unknown, label: string): number {
  if (
    !(
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^\d+$/.test(value))
    )
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${label}`);
  return count;
}

export function baselineProjection(category: Category): string {
  const source = DATASOURCES[category];
  const columns = [
    ...readFileSync(`datasources/${source}.datasource`, 'utf8').matchAll(/^\s+`([^`]+)`\s/gm),
  ].map((match) => `\`${match[1]}\``);
  if (columns.length === 0) throw new Error(`Missing ${source} schema`);
  return columns.join(',');
}
