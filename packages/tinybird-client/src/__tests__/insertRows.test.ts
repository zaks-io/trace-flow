import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyTinybirdInsertFailure,
  insertRows,
  shouldRetryTinybirdInsert,
} from '../insertRows';
import { TinybirdInsertError } from '../errors';

const HOST = 'https://api.tinybird.co';

function receiptResponse(successfulRows: number, quarantinedRows = 0): Response {
  return Response.json(
    { successful_rows: successfulRows, quarantined_rows: quarantinedRows },
    { status: 200 },
  );
}

function errorResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

describe('insertRows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs NDJSON to /v0/events with the bearer token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(receiptResponse(2));

    await insertRows([{ a: 1 }, { a: 2 }], 'tok', 'agent_message_facts', HOST);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${HOST}/v0/events?name=agent_message_facts&wait=true`);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init?.body).toBe('{"a":1}\n{"a":2}');
  });

  it('URL-encodes the datasource name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(receiptResponse(1));

    await insertRows([{ a: 1 }], 'tok', 'name with spaces', HOST);

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('name%20with%20spaces');
  });

  it('serializes an empty row set to an empty body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(receiptResponse(0));

    await insertRows([], 'tok', 'agent_message_facts', HOST);

    expect(fetchMock.mock.calls[0]![1]?.body).toBe('');
  });

  it('throws TinybirdInsertError carrying status + body on a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorResponse(422, 'quarantined rows'));

    await expect(insertRows([{ a: 1 }], 'tok', 'agent_message_facts', HOST)).rejects.toMatchObject({
      name: 'TinybirdInsertError',
      status: 422,
      responseText: 'quarantined rows',
      message: 'Tinybird insert failed: status=422 reason=http',
    });
  });

  it('rejects a 202 receipt because the database has not acknowledged the write', async () => {
    const responseText = '{"successful_rows":1,"quarantined_rows":0}';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(responseText, { status: 202 }),
    );

    await expect(insertRows([{ a: 1 }], 'tok', 'agent_message_facts', HOST)).rejects.toMatchObject({
      name: 'TinybirdInsertError',
      status: 202,
      reason: 'unconfirmed',
      responseText,
      message: 'Tinybird insert failed: status=202 reason=unconfirmed',
    });
  });

  it('rejects a partial receipt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(receiptResponse(2, 1));

    await expect(
      insertRows([{ a: 1 }, { a: 2 }], 'tok', 'agent_message_facts', HOST),
    ).rejects.toMatchObject({
      status: 200,
      reason: 'partial-receipt',
      responseText: '{"successful_rows":2,"quarantined_rows":1}',
      message: 'Tinybird insert failed: status=200 reason=partial-receipt',
    });
  });

  it('rejects a successful row count that does not match the batch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(receiptResponse(1));

    await expect(
      insertRows([{ a: 1 }, { a: 2 }], 'tok', 'agent_message_facts', HOST),
    ).rejects.toMatchObject({
      status: 200,
      reason: 'partial-receipt',
      responseText: '{"successful_rows":1,"quarantined_rows":0}',
      message: 'Tinybird insert failed: status=200 reason=partial-receipt',
    });
  });

  it('rejects a malformed receipt', async () => {
    const responseText = '{"successful_rows":"1","quarantined_rows":0}';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(responseText, { status: 200 }),
    );

    await expect(insertRows([{ a: 1 }], 'tok', 'agent_message_facts', HOST)).rejects.toMatchObject({
      status: 200,
      reason: 'malformed-receipt',
      responseText,
      message: 'Tinybird insert failed: status=200 reason=malformed-receipt',
    });
  });

  it('propagates network errors unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    await expect(insertRows([{ a: 1 }], 'tok', 'agent_message_facts', HOST)).rejects.toThrow(
      'Network error',
    );
  });
});

describe('classifyTinybirdInsertFailure', () => {
  it('classifies only 429 and 503 as safely retryable', () => {
    expect(classifyTinybirdInsertFailure(new TinybirdInsertError(429, ''))).toBe('retryable');
    expect(classifyTinybirdInsertFailure(new TinybirdInsertError(503, ''))).toBe('retryable');
  });

  it('classifies definitive request rejections', () => {
    for (const status of [400, 401, 403, 404, 413]) {
      expect(classifyTinybirdInsertFailure(new TinybirdInsertError(status, ''))).toBe('rejected');
    }
  });

  it('classifies timeouts, 202, malformed receipts, 422, and other failures as uncertain', () => {
    const failures = [
      new DOMException('Timed out', 'TimeoutError'),
      new TinybirdInsertError(202, '', 'unconfirmed'),
      new TinybirdInsertError(200, '', 'malformed-receipt'),
      new TinybirdInsertError(200, '', 'partial-receipt'),
      new TinybirdInsertError(422, 'partial ingestion'),
      new TinybirdInsertError(500, 'unexpected error'),
    ];

    for (const failure of failures) {
      expect(classifyTinybirdInsertFailure(failure)).toBe('uncertain');
      expect(shouldRetryTinybirdInsert(failure)).toBe(false);
    }
  });

  it('keeps shouldRetryTinybirdInsert as the retryable-only compatibility helper', () => {
    expect(shouldRetryTinybirdInsert(new TinybirdInsertError(429, ''))).toBe(true);
    expect(shouldRetryTinybirdInsert(new TinybirdInsertError(503, ''))).toBe(true);
    expect(shouldRetryTinybirdInsert(new TinybirdInsertError(400, ''))).toBe(false);
  });
});
