import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FACT_VERSION_DATASOURCES } from '../../apps/agent-consumer/src/delivery-write';
import { factIngestedAtMs, factPartitionKey } from '../../apps/agent-consumer/src/facts';
import {
  CATEGORIES,
  DATASOURCES,
  ROW_IDENTITY_FIELDS,
  identity,
  quote,
  type Category,
  type Row,
} from './agent-data';
import {
  type CanonicalHashIndex,
  type CanonicalHashRow,
  type SourceSchema,
} from './agent-canonical-index';
import { normalized, type AgentTinybirdClient } from './agent-transport';

export const CANONICAL_EXPORT_PAGE_SIZE = 5_000;

export async function exportCanonicalHashIndex(
  tb: AgentTinybirdClient,
  index: CanonicalHashIndex,
): Promise<void> {
  if (index.complete) return;
  for (const category of CATEGORIES) {
    const schema = await loadSourceSchema(tb, category);
    index.saveSourceSchema(category, schema);
    for (const eventDay of retainedDays(index.oldestDay, index.todayDay)) {
      if (index.dayComplete(category, eventDay)) continue;
      let after = index.progress(category, eventDay) ?? { afterSession: '', afterPk: '' };
      while (true) {
        const page = await readCanonicalPage(tb, index, category, eventDay, after, schema);
        if (page.rows.length === 0) {
          index.finishDay(category, eventDay);
          break;
        }
        index.savePage(category, eventDay, page.rows, page.afterSession, page.afterPk);
        after = { afterSession: page.afterSession, afterPk: page.afterPk };
      }
    }
  }
}

export async function readCanonicalPage(
  tb: AgentTinybirdClient,
  index: CanonicalHashIndex,
  category: Category,
  eventDay: string,
  after: { afterSession: string; afterPk: string },
  schema: SourceSchema,
): Promise<{ rows: CanonicalHashRow[]; afterSession: string; afterPk: string }> {
  const time = category === 'review_unit_attributions' ? 'DecidedAt' : 'EventAt';
  const [, sessionField, pkField] = ROW_IDENTITY_FIELDS[category];
  const result = await tb.sql(`SELECT ${schema.columns.join(',')},DeliverySequence,ContentHash
    FROM ${FACT_VERSION_DATASOURCES[category]} FINAL
    WHERE OrgId=${quote(index.orgId)} AND toDate(${time})=toDate(${quote(eventDay)})
      AND tuple(${sessionField},${pkField})>tuple(${quote(after.afterSession)},${quote(after.afterPk)})
      AND IsDeleted=0
    ORDER BY ${sessionField},${pkField} LIMIT ${CANONICAL_EXPORT_PAGE_SIZE}`);
  if (result.data.length > CANONICAL_EXPORT_PAGE_SIZE) {
    throw new Error('Canonical export page exceeds its bound');
  }
  const rows = result.data.map((row) =>
    canonicalHashRow(category, row, index.orgId, eventDay, schema),
  );
  const last = result.data.at(-1);
  return {
    rows,
    afterSession: last ? String(last[sessionField!]) : after.afterSession,
    afterPk: last ? String(last[pkField!]) : after.afterPk,
  };
}

function canonicalHashRow(
  category: Category,
  row: Row,
  orgId: string,
  eventDay: string,
  schema: SourceSchema,
): CanonicalHashRow {
  const factId = identity(category, row, orgId);
  const deliverySequence = Number(row.DeliverySequence);
  const contentHash = String(row.ContentHash);
  if (
    factPartitionKey(category, row) !== eventDay ||
    !Number.isSafeInteger(deliverySequence) ||
    deliverySequence < 1 ||
    !/^[a-f0-9]{64}$/.test(contentHash)
  ) {
    throw new Error('Invalid canonical row during hash export');
  }
  return {
    category,
    factId,
    eventDay,
    deliverySequence,
    contentHash,
    ingestedAtMs: factIngestedAtMs(row),
    rowSha256: createHash('sha256')
      .update(JSON.stringify(normalized(row, schema.meta)))
      .digest('hex'),
  };
}

async function loadSourceSchema(
  tb: AgentTinybirdClient,
  category: Category,
): Promise<SourceSchema> {
  const columns = datasourceColumns(DATASOURCES[category]);
  const { meta } = await tb.sql(`SELECT * FROM ${DATASOURCES[category]} LIMIT 0`);
  const expectedNames = columns.map((column) => column.slice(1, -1));
  if (
    meta.length !== columns.length ||
    meta.some(({ name }, index) => name !== expectedNames[index])
  ) {
    throw new Error(`Invalid ${category} source schema`);
  }
  return { columns, meta };
}

function datasourceColumns(datasource: string): string[] {
  const columns = [
    ...readFileSync(`datasources/${datasource}.datasource`, 'utf8').matchAll(/^\s+`([^`]+)`\s/gm),
  ].map((match) => `\`${match[1]}\``);
  if (columns.length === 0) throw new Error(`Missing datasource schema for ${datasource}`);
  return columns;
}

function* retainedDays(oldestDay: string, todayDay: string): Generator<string> {
  let current = Date.parse(`${oldestDay}T00:00:00Z`);
  const end = Date.parse(`${todayDay}T00:00:00Z`);
  while (current <= end) {
    yield new Date(current).toISOString().slice(0, 10);
    current += 86_400_000;
  }
}
