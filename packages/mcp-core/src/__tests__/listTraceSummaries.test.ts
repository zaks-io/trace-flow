import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listTraceSummaries } from '../tools/listTraceSummaries';
import type { ToolCtx } from '../tinybird';

let mockCtx: ToolCtx;

function mockFetchJson(responseData: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(responseData),
  } as Response);
}

describe('listTraceSummaries', () => {
  beforeEach(() => {
    mockCtx = {
      mintToken: vi.fn().mockResolvedValue('mock-jwt-token'),
      tinybirdBaseUrl: 'https://api.tinybird.co',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns aggregated trace summaries with pagination', async () => {
    mockFetchJson({
      data: [
        {
          trace_id: 'abcdef0123456789abcdef0123456789',
          timestamp: '2026-03-29T12:00:00.000Z',
          latest_received_at: '2026-03-29T12:00:01.250Z',
          capture_lag_ms: 1250,
          duration_ms: 850,
          status: 'error',
          span_count: 6,
          models: ['openai/gpt-4.1', ''],
          operations: ['heartbeat', ''],
          prompt_tokens: 100,
          completion_tokens: 25,
          total_tokens: 125,
          max_ttft_ms: 210,
          total_cost_usd: 0.0315,
          total_count: 2,
        },
      ],
    });

    const result = await listTraceSummaries(
      mockCtx,
      ['raw-key'],
      {
        limit: 1,
        hours: 24,
        sort_by: 'cost_usd',
      },
      7,
    );

    const payload = JSON.parse(result.content[0]!.text!);
    expect(payload.traces).toEqual([
      {
        trace_id: 'abcdef0123456789abcdef0123456789',
        timestamp: '2026-03-29T12:00:00.000Z',
        latest_received_at: '2026-03-29T12:00:01.250Z',
        capture_lag_ms: 1250,
        duration_ms: 850,
        status: 'error',
        span_count: 6,
        models: ['openai/gpt-4.1'],
        operations: ['heartbeat'],
        tokens: {
          prompt: 100,
          completion: 25,
          total: 125,
        },
        max_ttft_ms: 210,
        cost_usd: 0.0315,
      },
    ]);
    expect(payload.pagination).toEqual({
      has_more: true,
      next_cursor: '1',
      limit: 1,
    });
  });

  it('queries the dedicated MCP trace summaries pipe', async () => {
    mockFetchJson({ data: [] });

    await listTraceSummaries(
      mockCtx,
      ['raw-key'],
      {
        operation: 'key-art',
        trace_id: 'abcdef0123456789abcdef0123456789',
      },
      7,
    );

    const call = vi.mocked(globalThis.fetch).mock.calls[0]![0] as string;
    expect(call).toContain('/v0/pipes/mcp_trace_summaries.json');
    expect(call).toContain('operation=key-art');
    expect(call).toContain('trace_id=abcdef0123456789abcdef0123456789');
  });
});
