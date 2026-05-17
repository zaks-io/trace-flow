import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchPipe } from '../fetchPipe';
import { TinybirdAuthError, TinybirdQueryError } from '../errors';

const BASE = 'https://api.tinybird.co';

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockTextResponse(text: string, status: number): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

describe('fetchPipe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds /v0/pipes/<pipe>.json URL with bearer token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJsonResponse({ data: [{ x: 1 }] }));

    await fetchPipe({ baseUrl: BASE, token: 't0k', pipe: 'trace_detail' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/v0/pipes/trace_detail.json`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer t0k');
  });

  it('forwards params as query string and skips undefined', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJsonResponse({ data: [] }));

    await fetchPipe({
      baseUrl: BASE,
      token: 't',
      pipe: 'trace_detail',
      params: { trace_id: 'abc', limit: 10, missing: undefined, flag: true },
    });

    const [url] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('trace_id')).toBe('abc');
    expect(parsed.searchParams.get('limit')).toBe('10');
    expect(parsed.searchParams.get('flag')).toBe('true');
    expect(parsed.searchParams.has('missing')).toBe(false);
  });

  it('returns rows from response.data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({ data: [{ id: 1 }, { id: 2 }] }),
    );

    const rows = await fetchPipe<{ id: number }>({ baseUrl: BASE, token: 't', pipe: 'p' });
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('throws TinybirdAuthError on 403 by default (retry mode)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockTextResponse('forbidden', 403));

    await expect(fetchPipe({ baseUrl: BASE, token: 't', pipe: 'p' })).rejects.toBeInstanceOf(
      TinybirdAuthError,
    );
  });

  it('collapses 403 into TinybirdQueryError when retry: false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockTextResponse('forbidden', 403));

    await expect(
      fetchPipe({ baseUrl: BASE, token: 't', pipe: 'p', retry: false }),
    ).rejects.toBeInstanceOf(TinybirdQueryError);
  });

  it('throws TinybirdQueryError on other non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockTextResponse('server error', 500));

    const promise = fetchPipe({ baseUrl: BASE, token: 't', pipe: 'p' });
    await expect(promise).rejects.toBeInstanceOf(TinybirdQueryError);
    await promise.catch((err: TinybirdQueryError) => {
      expect(err.status).toBe(500);
    });
  });

  it('parses rows through schema.parse when provided', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({ data: [{ raw: 1 }, { raw: 2 }] }),
    );
    const schema = {
      parse: vi.fn((row: unknown) => ({ parsed: (row as { raw: number }).raw * 10 })),
    };

    const rows = await fetchPipe<{ parsed: number }>({
      baseUrl: BASE,
      token: 't',
      pipe: 'p',
      schema,
    });

    expect(schema.parse).toHaveBeenCalledTimes(2);
    expect(rows).toEqual([{ parsed: 10 }, { parsed: 20 }]);
  });

  it('returns empty array when response.data is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJsonResponse({}));
    const rows = await fetchPipe({ baseUrl: BASE, token: 't', pipe: 'p' });
    expect(rows).toEqual([]);
  });
});
