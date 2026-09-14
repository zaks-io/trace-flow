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
): Promise<BaselineCategoryProof[]> {
  const proofs: BaselineCategoryProof[] = [];
  for (const category of CATEGORIES) {
    const time = category === 'review_unit_attributions' ? 'DecidedAt' : 'EventAt';
    const identity = ROW_IDENTITY_FIELDS[category].join(',');
    const rows = (
      await tb.sql(
        `SELECT count() AS rows, uniqExact(tuple(${identity})) AS identities, arraySort(groupUniqArray(toString(toDate(${time})))) AS days FROM ${DATASOURCES[category]} WHERE ${migrationScope(category, org, window)}`,
      )
    ).data;
    const row = rows[0];
    if (
      !row ||
      !Number.isSafeInteger(Number(row.rows)) ||
      Number(row.rows) !== Number(row.identities) ||
      !Array.isArray(row.days) ||
      row.days.length > 367
    ) {
      throw new Error(`Source ${category} is not uniquely defined; baseline requires repair`);
    }
    proofs.push({ category, rows: Number(row.rows), days: row.days as string[] });
  }
  return proofs;
}

export async function verifyBaseline(
  tb: AgentTinybirdClient,
  org: string,
  window: MigrationWindow,
  proof: BaselineCategoryProof,
): Promise<void> {
  const { category } = proof;
  const source = DATASOURCES[category],
    target = FACT_VERSION_DATASOURCES[category];
  const columns = [
    ...readFileSync(`datasources/${source}.datasource`, 'utf8').matchAll(/^\s+`([^`]+)`\s/gm),
  ].map((match) => `\`${match[1]}\``);
  if (columns.length === 0) throw new Error(`Missing ${source} schema`);
  const projection = columns.join(',');
  const time = category === 'review_unit_attributions' ? 'DecidedAt' : 'EventAt';
  const identity = `concat(${ROW_IDENTITY_FIELDS[category].join(', char(31), ')})`;
  let verifiedSourceRows = 0;
  let verifiedTargetRows = 0;
  let verifiedSourceIndexRows = 0;
  let verifiedTargetIndexRows = 0;

  for (const chunk of chunkAgentDayRange(window)) {
    const scope = migrationScope(category, org, chunk);
    const content = (
      await tb.sql(`WITH
        source_rows AS (
          SELECT ${projection} FROM ${source} WHERE ${scope}
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
    const sourceRows = safeCount(content?.source_rows, `${category} source rows`);
    const targetRows = safeCount(content?.target_rows, `${category} target rows`);
    if (
      sourceRows !== targetRows ||
      safeCount(content?.invalid_metadata, `${category} invalid metadata`) !== 0 ||
      Number(content?.missing_target) ||
      Number(content?.unexpected_target)
    ) {
      throw new Error(
        `Exact ${category} baseline parity failed for ${chunk.startDay} through ${chunk.endDay}`,
      );
    }
    verifiedSourceRows += sourceRows;
    verifiedTargetRows += targetRows;

    const sourceIndex = `SELECT ${identity} AS FactIdentity, toDate(${time}) AS EventDay FROM ${source} WHERE ${scope}`;
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
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${label}`);
  return count;
}
