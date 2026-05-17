import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAdminSql } from '../runAdminSql';
import { TinybirdQueryError } from '../errors';

const BASE = 'https://api.tinybird.co';

describe('runAdminSql', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs SQL to /v0/sql with admin bearer + text/plain', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ ok: true }] })));

    const rows = await runAdminSql({ baseUrl: BASE, adminToken: 'ADMIN', sql: 'SELECT 1' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/v0/sql`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('SELECT 1');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ADMIN');
    expect(headers['Content-Type']).toBe('text/plain');
    expect(rows).toEqual([{ ok: true }]);
  });

  it('throws TinybirdQueryError on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('bad', { status: 400 }));

    const promise = runAdminSql({ baseUrl: BASE, adminToken: 'a', sql: 'x' });
    await expect(promise).rejects.toBeInstanceOf(TinybirdQueryError);
    await promise.catch((err: TinybirdQueryError) => {
      expect(err.status).toBe(400);
    });
  });

  it('returns [] when data is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({})));
    const rows = await runAdminSql({ baseUrl: BASE, adminToken: 'a', sql: 'DELETE FROM x' });
    expect(rows).toEqual([]);
  });
});
