import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTraceSpans } from '../tools/getTraceSpansAction';
import type { ToolCtx } from '../tinybird';

const TRACE_ID = 'abcdef0123456789abcdef0123456789';

let mockCtx: ToolCtx;

function mockFetchJson(responseData: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(responseData),
  } as Response);
}

function parseResultText(result: Awaited<ReturnType<typeof getTraceSpans>>) {
  return JSON.parse(result.content[0]!.text!);
}

function spanRow(spanId: string, totalCount: number) {
  return {
    ReceivedAt: 1700000000000000000,
    Timestamp: 1700000000000000000,
    TraceId: TRACE_ID,
    SpanId: spanId,
    ParentSpanId: '',
    SpanName: 'gen_ai.request',
    Duration: 150000000,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    SpanAttributes: '{}',
    total_count: totalCount,
  };
}

describe('getTraceSpans', () => {
  beforeEach(() => {
    mockCtx = {
      mintToken: vi.fn().mockResolvedValue('mock-jwt-token'),
      tinybirdBaseUrl: 'https://api.tinybird.co',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty page when a stale cursor is beyond the available spans', async () => {
    mockFetchJson({ data: [] });

    const result = await getTraceSpans(
      mockCtx,
      ['raw-key'],
      {
        trace_id: TRACE_ID,
        limit: 10,
        cursor: '100',
      },
      7,
    );

    expect(result.isError).toBeUndefined();
    expect(parseResultText(result)).toEqual({
      trace_id: TRACE_ID,
      spans: [],
      pagination: {
        has_more: false,
      },
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0]![0] as string;
    expect(call).toContain('limit=10');
    expect(call).toContain('offset=100');
  });

  it('keeps spans empty when a top_n page cursor is beyond the fetched set', async () => {
    mockFetchJson({
      data: [spanRow('span-1', 2), spanRow('span-2', 2)],
    });

    const result = await getTraceSpans(
      mockCtx,
      ['raw-key'],
      {
        trace_id: TRACE_ID,
        top_n: 2,
        limit: 1,
        cursor: '5',
      },
      7,
    );

    expect(parseResultText(result)).toEqual({
      trace_id: TRACE_ID,
      spans: [],
      pagination: {
        has_more: false,
        total: 2,
      },
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0]![0] as string;
    expect(call).toContain('limit=2');
    expect(call).toContain('offset=0');
  });
});
