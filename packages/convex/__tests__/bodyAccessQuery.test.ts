import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAdminSql } from '@trace-flow/tinybird-client';
import { buildBodyAccessOwnershipSql } from '../bodyAccess';

const VALID_ANALYTICS_KEY_ID = `sha256:${'1'.repeat(64)}`;

function stubTinybird(rows: Record<string, unknown>[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const sql = String(init?.body);
      return sql.includes('FORMAT JSON')
        ? new Response(JSON.stringify({ data: rows }))
        : new Response('1\n');
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('body access ownership query', () => {
  it('returns a matching ownership row through the Tinybird admin SQL client', async () => {
    stubTinybird([{ '1': 1 }]);
    const sql = buildBodyAccessOwnershipSql({
      requestId: 'req_123',
      analyticsKeyIds: [VALID_ANALYTICS_KEY_ID],
    });

    expect(sql).not.toBeNull();
    const rows = await runAdminSql({
      baseUrl: 'https://api.tinybird.test',
      adminToken: 'test-admin-token',
      sql: sql!,
    });

    expect(rows).toEqual([{ '1': 1 }]);
  });

  it('returns no ownership rows when Tinybird JSON data is empty', async () => {
    stubTinybird([]);
    const sql = buildBodyAccessOwnershipSql({
      requestId: 'req_missing',
      analyticsKeyIds: [VALID_ANALYTICS_KEY_ID],
    });

    expect(sql).not.toBeNull();
    const rows = await runAdminSql({
      baseUrl: 'https://api.tinybird.test',
      adminToken: 'test-admin-token',
      sql: sql!,
    });

    expect(rows).toEqual([]);
  });
});
