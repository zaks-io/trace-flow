import type { Scope } from '@sentry/core';
import { TinybirdQueryError } from './errors';
import {
  finishTinybirdQuerySpan,
  recordTinybirdResponse,
  recordTinybirdStatistics,
  startTinybirdQuerySpan,
} from './tracing';

export interface RunAdminSqlOptions {
  baseUrl: string;
  adminToken: string;
  sql: string;
  /** Explicit Sentry scope for runtimes where request scopes are not globally active. */
  sentryScope?: Scope;
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
  sentryScope,
}: RunAdminSqlOptions): Promise<Record<string, unknown>[]> {
  const span = startTinybirdQuerySpan({ baseUrl, sentryScope });
  let succeeded = false;

  try {
    const url = new URL(`${baseUrl}/v0/sql`);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
    });
    recordTinybirdResponse(span, response);

    if (!response.ok) {
      const errorText = await response.text();
      throw new TinybirdQueryError(
        `Tinybird admin SQL failed: ${response.status} - ${errorText}`,
        response.status,
      );
    }

    const body: SqlResponse = await response.json();
    recordTinybirdStatistics(span, body);
    succeeded = true;
    return body.data ?? [];
  } finally {
    finishTinybirdQuerySpan(span, succeeded);
  }
}

/**
 * Variant for SQL statements that don't return rows (ALTER TABLE DELETE / UPDATE).
 * Discards the response body — same auth, same error mapping.
 */
export async function runAdminSqlNoResult(opts: RunAdminSqlOptions): Promise<void> {
  await runAdminSql(opts);
}
