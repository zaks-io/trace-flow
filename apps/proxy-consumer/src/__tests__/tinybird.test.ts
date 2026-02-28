import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insertIntoTinybird, insertIntoTinybirdWithRetry } from '../tinybird';
import type { TinybirdTrace } from '@trace-flow/types';

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

  it('should successfully insert traces', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    global.fetch = mockFetch;

    await insertIntoTinybird([mockTrace], 'test-token', 'otel_traces', 'https://api.tinybird.co');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.tinybird.co/v0/events?name=otel_traces&wait=true',
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
    global.fetch = mockFetch;

    const trace1 = { ...mockTrace, TraceId: 'trace-1' };
    const trace2 = { ...mockTrace, TraceId: 'trace-2' };

    await insertIntoTinybird(
      [trace1, trace2],
      'test-token',
      'otel_traces',
      'https://api.tinybird.co',
    );

    const call = mockFetch.mock.calls[0];
    const body = call?.[1]?.body as string;

    expect(body).toContain('"TraceId":"trace-1"');
    expect(body).toContain('"TraceId":"trace-2"');
    expect(body.split('\n').length).toBe(2);
  });

  it('should URL encode datasource name', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    global.fetch = mockFetch;

    await insertIntoTinybird(
      [mockTrace],
      'test-token',
      'otel traces with spaces',
      'https://api.tinybird.co',
    );

    const call = mockFetch.mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain('otel%20traces%20with%20spaces');
    expect(url).toContain('wait=true');
  });

  it('should throw error on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request error'),
    });
    global.fetch = mockFetch;

    await expect(
      insertIntoTinybird([mockTrace], 'test-token', 'otel_traces', 'https://api.tinybird.co'),
    ).rejects.toThrow('Tinybird insert failed: 400 Bad request error');
  });

  it('should handle 401 unauthorized', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });
    global.fetch = mockFetch;

    await expect(
      insertIntoTinybird([mockTrace], 'invalid-token', 'otel_traces', 'https://api.tinybird.co'),
    ).rejects.toThrow('Tinybird insert failed: 401 Unauthorized');
  });

  it('should handle 500 server error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal server error'),
    });
    global.fetch = mockFetch;

    await expect(
      insertIntoTinybird([mockTrace], 'test-token', 'otel_traces', 'https://api.tinybird.co'),
    ).rejects.toThrow('Tinybird insert failed: 500 Internal server error');
  });

  it('should use custom host', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    global.fetch = mockFetch;

    await insertIntoTinybird([mockTrace], 'test-token', 'otel_traces', 'http://localhost:7181');

    const call = mockFetch.mock.calls[0];
    const url = call?.[0] as string;
    expect(url).toContain('http://localhost:7181/v0/events');
    expect(url).toContain('wait=true');
  });

  it('should handle multiple traces', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    global.fetch = mockFetch;

    const traces = Array.from({ length: 10 }, (_, i) => ({
      ...mockTrace,
      TraceId: `trace-${i}`,
    }));

    await insertIntoTinybird(traces, 'test-token', 'otel_traces', 'https://api.tinybird.co');

    const call = mockFetch.mock.calls[0];
    const body = call?.[1]?.body as string;
    expect(body.split('\n').length).toBe(10);
  });

  it('should handle network errors', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    global.fetch = mockFetch;

    await expect(
      insertIntoTinybird([mockTrace], 'test-token', 'otel_traces', 'https://api.tinybird.co'),
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

  it('should succeed on first attempt', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    global.fetch = mockFetch;

    await insertIntoTinybirdWithRetry(
      [mockTrace],
      'test-token',
      'otel_traces',
      'https://api.tinybird.co',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
    global.fetch = mockFetch;

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await insertIntoTinybirdWithRetry(
      [mockTrace],
      'test-token',
      'otel_traces',
      'https://api.tinybird.co',
      mockDelay,
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockDelay).toHaveBeenCalledTimes(1);
  });

  it('should throw error after max retries', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server error'),
    });
    global.fetch = mockFetch;

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await expect(
      insertIntoTinybirdWithRetry(
        [mockTrace],
        'test-token',
        'otel_traces',
        'https://api.tinybird.co',
        mockDelay,
      ),
    ).rejects.toThrow('Tinybird insert failed: 500 Server error');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockDelay).toHaveBeenCalledTimes(2);
  });

  it('should not retry on 422 partial ingestion errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Partial ingestion error'),
    });
    global.fetch = mockFetch;

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await expect(
      insertIntoTinybirdWithRetry(
        [mockTrace],
        'test-token',
        'otel_traces',
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
    global.fetch = mockFetch;

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await expect(
      insertIntoTinybirdWithRetry(
        [mockTrace],
        'test-token',
        'otel_traces',
        'https://api.tinybird.co',
        mockDelay,
      ),
    ).rejects.toThrow('Tinybird insert failed: 400 Bad request error');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it('should use exponential backoff', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Error 1'),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Error 2'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
    global.fetch = mockFetch;

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await insertIntoTinybirdWithRetry(
      [mockTrace],
      'test-token',
      'otel_traces',
      'https://api.tinybird.co',
      mockDelay,
    );

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockDelay).toHaveBeenCalledTimes(2);
    expect(mockDelay.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1000);
    expect(mockDelay.mock.calls[1]?.[0]).toBeGreaterThanOrEqual(2000);
  });

  it('should handle non-Error exceptions', async () => {
    const mockFetch = vi.fn().mockRejectedValue('String error');
    global.fetch = mockFetch;

    const mockDelay = vi.fn().mockResolvedValue(undefined);

    await expect(
      insertIntoTinybirdWithRetry(
        [mockTrace],
        'test-token',
        'otel_traces',
        'https://api.tinybird.co',
        mockDelay,
      ),
    ).rejects.toThrow('String error');
  });

  it('should use default setTimeout delay function when not provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
    global.fetch = mockFetch;

    await insertIntoTinybirdWithRetry(
      [mockTrace],
      'test-token',
      'otel_traces',
      'https://api.tinybird.co',
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
