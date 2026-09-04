import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { insertIntoTinybird, insertIntoTinybirdWithRetry } from '../tinybird';
import type { TinybirdTrace } from '@trace-flow/types';
import { analyticsKeyId } from '@trace-flow/utils';

describe('insertIntoTinybird', () => {
  const mockTrace: TinybirdTrace = {
    ReceivedAt: 1700000000000000000,
    Timestamp: 1000000000,
    TraceId: 'trace-123',
    SpanId: 'span-456',
    ParentSpanId: '',
    TraceState: '',
    SpanName: 'test.span',
    SpanKind: 'SPAN_KIND_CLIENT',
    ServiceName: 'test-service',
    ResourceAttributes: {},
    SpanAttributes: {},
    Duration: 500000,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    ApiKey: 'test-key',
    'Events.Timestamp': [],
    'Events.Name': [],
    'Events.Attributes': [],
    'Links.TraceId': [],
    'Links.SpanId': [],
    'Links.TraceState': [],
    'Links.Attributes': [],
    TierAtIngestion: 'hobby',
    RetentionExpiresAt: 1700604800000000000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('should successfully insert traces', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    await insertIntoTinybird(
      [mockTrace],
      'test-token',
      'otel_trace_spans',
      'https://api.tinybird.co',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.tinybird.co/v0/events?name=otel_trace_spans',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
      }),
    );
  });

  it('should format traces as NDJSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    const trace1 = { ...mockTrace, TraceId: 'trace-1' };
    const identifier = await analyticsKeyId(mockTrace.ApiKey);
    const trace2 = { ...mockTrace, TraceId: 'trace-2', ApiKey: identifier };

    await insertIntoTinybird(
      [trace1, trace2],
      'test-token',
      'otel_trace_spans',
      'https://api.tinybird.co',
    );

    const call = mockFetch.mock.calls[0];
    const body = call?.[1]?.body as string;

    expect(body).toContain('"TraceId":"trace-1"');
    expect(body).toContain('"TraceId":"trace-2"');
    expect(body.split('\n').length).toBe(2);
    expect(body).not.toContain(mockTrace.ApiKey);
    expect(body.split('\n').map((line) => JSON.parse(line).ApiKey)).toEqual([
      identifier,
      identifier,
    ]);
  });

  it('should URL encode datasource name', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    await insertIntoTinybird(
      [mockTrace],
      'test-token',
      'otel traces with spaces',
      'https://api.tinybird.co',
    );

    const call = mockFetch.mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain('otel%20traces%20with%20spaces');
    expect(url).not.toContain('wait=true');
  });

  it('should throw error on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      insertIntoTinybird([mockTrace], 'test-token', 'otel_trace_spans', 'https://api.tinybird.co'),
    ).rejects.toThrow('Tinybird insert failed: 400 Bad request error');
  });

  it('should handle 401 unauthorized', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      insertIntoTinybird(
        [mockTrace],
        'invalid-token',
        'otel_trace_spans',
        'https://api.tinybird.co',
      ),
    ).rejects.toThrow('Tinybird insert failed: 401 Unauthorized');
  });

  it('should handle 500 server error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal server error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      insertIntoTinybird([mockTrace], 'test-token', 'otel_trace_spans', 'https://api.tinybird.co'),
    ).rejects.toThrow('Tinybird insert failed: 500 Internal server error');
  });

  it('should use custom host', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    await insertIntoTinybird(
      [mockTrace],
      'test-token',
      'otel_trace_spans',
      'http://localhost:7181',
    );

    const call = mockFetch.mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain('http://localhost:7181/v0/events');
    expect(url).not.toContain('wait=true');
  });

  it('should handle multiple traces', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    const traces = Array.from({ length: 10 }, (_, i) => ({
      ...mockTrace,
      TraceId: `trace-${i}`,
    }));

    await insertIntoTinybird(traces, 'test-token', 'otel_trace_spans', 'https://api.tinybird.co');

    const call = mockFetch.mock.calls[0];
    const body = call?.[1]?.body as string;
    expect(body.split('\n').length).toBe(10);
  });

  it('should handle network errors', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      insertIntoTinybird([mockTrace], 'test-token', 'otel_trace_spans', 'https://api.tinybird.co'),
    ).rejects.toThrow('Network error');
  });
});

describe('insertIntoTinybirdWithRetry', () => {
  const mockTrace: TinybirdTrace = {
    ReceivedAt: 1700000000000000000,
    Timestamp: 1000000000,
    TraceId: 'trace-123',
    SpanId: 'span-456',
    ParentSpanId: '',
    TraceState: '',
    SpanName: 'test.span',
    SpanKind: 'SPAN_KIND_CLIENT',
    ServiceName: 'test-service',
    ResourceAttributes: {},
    SpanAttributes: {},
    Duration: 500000,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    ApiKey: 'test-key',
    'Events.Timestamp': [],
    'Events.Name': [],
    'Events.Attributes': [],
    'Links.TraceId': [],
    'Links.SpanId': [],
    'Links.TraceState': [],
    'Links.Attributes': [],
    TierAtIngestion: 'hobby',
    RetentionExpiresAt: 1700604800000000000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('should succeed on first attempt', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', mockFetch);

    await insertIntoTinybirdWithRetry(
      [mockTrace],
      'test-token',
      'otel_trace_spans',
      'https://api.tinybird.co',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should not retry on failure (MAX_RETRIES = 1)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await expect(
      insertIntoTinybirdWithRetry(
        [mockTrace],
        'test-token',
        'otel_trace_spans',
        'https://api.tinybird.co',
        mockDelay,
      ),
    ).rejects.toThrow('Tinybird insert failed: 500 Server error');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it('should not retry on 422 partial ingestion errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Partial ingestion error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await expect(
      insertIntoTinybirdWithRetry(
        [mockTrace],
        'test-token',
        'otel_trace_spans',
        'https://api.tinybird.co',
        mockDelay,
      ),
    ).rejects.toThrow('Tinybird insert failed: 422 Partial ingestion error');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it('should not retry on 400 errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await expect(
      insertIntoTinybirdWithRetry(
        [mockTrace],
        'test-token',
        'otel_trace_spans',
        'https://api.tinybird.co',
        mockDelay,
      ),
    ).rejects.toThrow('Tinybird insert failed: 400 Bad request error');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it('should handle non-Error exceptions', async () => {
    const mockFetch = vi.fn().mockRejectedValue('String error');
    vi.stubGlobal('fetch', mockFetch);

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await expect(
      insertIntoTinybirdWithRetry(
        [mockTrace],
        'test-token',
        'otel_trace_spans',
        'https://api.tinybird.co',
        mockDelay,
      ),
    ).rejects.toThrow('String error');
  });
});
