import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUsageSummary, listModelUsage, listOperationUsage } from '../tools/analytics';
import type { ToolCtx } from '../tinybird';

const mockCtx: ToolCtx = {
  mintToken: vi.fn().mockResolvedValue('mock-jwt-token'),
  tinybirdBaseUrl: 'https://api.tinybird.co',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('analytics MCP helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats usage summary totals and error rate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          {
            request_count: 20,
            error_count: 5,
            input_tokens: 1000,
            uncached_input_tokens: 800,
            output_tokens: 400,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 50,
            reasoning_tokens: 25,
            total_tokens: 1400,
            total_cost_usd: 1.5,
            input_cost_usd: 0.4,
            output_cost_usd: 0.7,
            cache_read_cost_usd: 0.1,
            cache_creation_cost_usd: 0.05,
            reasoning_cost_usd: 0.02,
            prompt_baseline_cost_usd: 0.6,
            cache_impact_cost_usd: 0.2,
            upstream_cost_usd: 0.03,
            avg_duration_ms: 250,
            max_duration_ms: 1200,
            p95_duration_ms: 900,
          },
        ],
      }),
    );

    const result = await getUsageSummary(
      mockCtx,
      ['raw-key'],
      { hours: 24, operation: 'heartbeat' },
      7,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.window.hours).toBe(24);
    expect(payload.summary.error_rate).toBe(0.25);
    expect(payload.summary.tokens.total).toBe(1400);
    expect(payload.summary.cost_usd.total).toBe(1.5);
    expect(payload.summary.duration_ms.p95).toBe(900);
  });

  it('formats operation leaderboard rows and passes through limit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          {
            operation: 'heartbeat',
            request_count: 8,
            unique_user_count: 3,
            input_tokens: 100,
            uncached_input_tokens: 90,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 0,
            reasoning_tokens: 5,
            total_tokens: 150,
            total_cost_usd: 0.8,
            input_cost_usd: 0.2,
            output_cost_usd: 0.4,
            cache_read_cost_usd: 0.01,
            cache_creation_cost_usd: 0,
            reasoning_cost_usd: 0.02,
            prompt_baseline_cost_usd: 0.25,
            cache_impact_cost_usd: 0.05,
            upstream_cost_usd: 0,
            avg_duration_ms: 300,
            max_duration_ms: 900,
            p95_duration_ms: 850,
            cost_per_request_usd: 0.1,
            cost_per_user_usd: 0.266667,
            cache_hit_rate: 10,
          },
        ],
      }),
    );

    const result = await listOperationUsage(
      mockCtx,
      ['raw-key'],
      {
        hours: 48,
        model: 'gpt-4.1',
        limit: 5,
      },
      7,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.operations[0].operation).toBe('heartbeat');
    expect(payload.operations[0].duration_ms.p95).toBe(850);
    expect(payload.operations[0].cache_hit_rate).toBe(10);

    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain('/v0/pipes/operations_leaderboard.json');
    expect(call).toContain('limit=5');
    expect(call).toContain('model=gpt-4.1');
  });

  it('formats model usage rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          {
            model: 'anthropic/claude-3-7-sonnet',
            request_count: 12,
            input_tokens: 500,
            uncached_input_tokens: 400,
            output_tokens: 250,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 0,
            reasoning_tokens: 20,
            total_tokens: 750,
            total_cost_usd: 1.1,
            input_cost_usd: 0.3,
            output_cost_usd: 0.6,
            cache_read_cost_usd: 0.02,
            cache_creation_cost_usd: 0,
            reasoning_cost_usd: 0.03,
            prompt_baseline_cost_usd: 0.35,
            cache_impact_cost_usd: 0.08,
            upstream_cost_usd: 0.01,
            cost_per_1k_output_tokens: 2.4,
            avg_duration_ms: 420,
            max_duration_ms: 1400,
            p95_duration_ms: 1200,
          },
        ],
      }),
    );

    const result = await listModelUsage(
      mockCtx,
      ['raw-key'],
      {
        hours: 72,
        provider: 'anthropic',
        status: 'STATUS_CODE_OK',
      },
      7,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.models[0].model).toBe('anthropic/claude-3-7-sonnet');
    expect(payload.models[0].cost_per_1k_output_tokens).toBe(2.4);
    expect(payload.models[0].tokens.total).toBe(750);
  });
});
