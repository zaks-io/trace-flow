import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insertRows, shouldRetryTinybirdInsert } from '../insertRows';
import { TinybirdInsertError } from '../errors';

const HOST = 'https://api.tinybird.co';

function okResponse(): Response {
  return new Response('', { status: 200 });
}

function errorResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

describe('insertRows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs NDJSON to /v0/events with the bearer token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResponse());

    await insertRows([{ a: 1 }, { a: 2 }], 'tok', 'agent_messages', HOST);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${HOST}/v0/events?name=agent_messages`);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init?.body).toBe('{"a":1}\n{"a":2}');
  });

  it('URL-encodes the datasource name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResponse());

    await insertRows([{ a: 1 }], 'tok', 'name with spaces', HOST);

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('name%20with%20spaces');
  });

  it('serializes an empty row set to an empty body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okResponse());

    await insertRows([], 'tok', 'agent_messages', HOST);

    expect(fetchMock.mock.calls[0]![1]?.body).toBe('');
  });

  it('throws TinybirdInsertError carrying status + body on a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorResponse(422, 'quarantined rows'));

    await expect(insertRows([{ a: 1 }], 'tok', 'agent_messages', HOST)).rejects.toMatchObject({
      name: 'TinybirdInsertError',
      status: 422,
      responseText: 'quarantined rows',
      message: 'Tinybird insert failed: 422 quarantined rows',
    });
  });

  it('propagates network errors unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    await expect(insertRows([{ a: 1 }], 'tok', 'agent_messages', HOST)).rejects.toThrow(
      'Network error',
    );
  });
});

describe('shouldRetryTinybirdInsert', () => {
  it('retries transient statuses (429, 503, 5xx) and non-insert errors', () => {
    expect(shouldRetryTinybirdInsert(new TinybirdInsertError(429, ''))).toBe(true);
    expect(shouldRetryTinybirdInsert(new TinybirdInsertError(503, ''))).toBe(true);
    expect(shouldRetryTinybirdInsert(new TinybirdInsertError(500, ''))).toBe(true);
    expect(shouldRetryTinybirdInsert(new Error('timeout'))).toBe(true);
  });

  it('does not retry terminal client errors (400/401/403/404/413/422)', () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(shouldRetryTinybirdInsert(new TinybirdInsertError(status, ''))).toBe(false);
    }
  });
});
