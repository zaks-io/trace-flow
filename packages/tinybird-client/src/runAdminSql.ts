import { TinybirdQueryError } from './errors';

export interface RunAdminSqlOptions {
  baseUrl: string;
  adminToken: string;
  sql: string;
}

interface SqlResponse {
  data?: Record<string, unknown>[];
}

/**
 * POSTs raw SQL to Tinybird's `/v0/sql` with the admin bearer token. Returns the
 * decoded `data` rows. Use only for admin-only operations (DDL, ALTER TABLE);
 * for read queries scoped to an org, use `fetchPipe` with a per-org JWT.
 */
export async function runAdminSql({
  baseUrl,
  adminToken,
  sql,
}: RunAdminSqlOptions): Promise<Record<string, unknown>[]> {
  const url = new URL(`${baseUrl}/v0/sql`);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new TinybirdQueryError(
      `Tinybird admin SQL failed: ${response.status} - ${errorText}`,
      response.status,
    );
  }

  const body: SqlResponse = await response.json();
  return body.data ?? [];
}

/**
 * Variant for SQL statements that don't return rows (ALTER TABLE DELETE / UPDATE).
 * Discards the response body — same auth, same error mapping.
 */
export async function runAdminSqlNoResult(opts: RunAdminSqlOptions): Promise<void> {
  await runAdminSql(opts);
}
