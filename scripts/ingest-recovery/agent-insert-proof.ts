import { createHash } from 'node:crypto';
import { quote, type Row } from './agent-data';
import { AgentTinybirdClient, normalized } from './agent-transport';

export function exactStorageHash(row: Row): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

export async function confirmExistingInsert(
  tinybird: AgentTinybirdClient,
  table: string,
  org: string,
  keys: string[],
  expected: Row[],
): Promise<boolean> {
  const tuples = expected.map(
    (row) => `tuple(${keys.map((key) => quote(String(row[key]))).join(',')})`,
  );
  const result = await tinybird.sql(
    `SELECT * FROM ${table} WHERE OrgId=${quote(org)} AND tuple(${keys.join(',')}) IN (${tuples.join(',')})`,
  );
  if (result.data.length !== expected.length) return false;
  const identity = (row: Row) => JSON.stringify(keys.map((key) => row[key]));
  const desired = new Map(
    expected.map((row) => [identity(row), exactStorageHash(normalized(row, result.meta))]),
  );
  for (const row of result.data) {
    const key = identity(row);
    if (desired.get(key) !== exactStorageHash(normalized(row, result.meta))) return false;
    desired.delete(key);
  }
  return desired.size === 0;
}
