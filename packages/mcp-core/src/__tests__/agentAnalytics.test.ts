import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeAgentAnalytics, queryAgentAnalytics } from '../tools/agentAnalytics';
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

describe('queryAgentAnalytics', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('describes allowed filters with discovered values', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              group_value: 'codex',
              message_count: 12,
              session_count: 3,
              total_tokens: 1000,
              cost_usd: 0.5,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              group_value: 'gpt-5.5',
              message_count: 10,
              session_count: 2,
              total_tokens: 900,
              cost_usd: 0.45,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              group_value: 'repo_123',
              message_count: 10,
              session_count: 2,
              total_tokens: 900,
              cost_usd: 0.45,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              repo_fingerprint: 'repo_123',
              normalized_git_remote: 'github.com/zaks-io/trace-flow',
              repo_path_fallback: 'trace-flow',
              repo_source: 'git_remote',
            },
          ],
        }),
      );

    const result = await describeAgentAnalytics(
      mockCtx,
      [],
      {
        start_time: '2026-06-04T00:00:00Z',
        end_time: '2026-06-11T00:00:00Z',
        filters: { sources: ['codex'] },
      },
      30,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.views.summary).toContain('KPI');
    expect(payload.views.context_health).toContain('context');
    expect(payload.views.review_units).toContain('Direct-link');
    expect(payload.views.sessions).toBeUndefined();
    expect(payload.filters.sources.allowed_values).toContain('codex');
    expect(payload.view_parameters.timeseries.group_by).toContain('repo');
    expect(payload.discovered_values.sources[0].value).toBe('codex');
    expect(payload.discovered_values.models[0].value).toBe('gpt-5.5');
    expect(payload.discovered_values.repo_fingerprints[0]).toMatchObject({
      repo_fingerprint: 'repo_123',
      normalized_git_remote: 'github.com/zaks-io/trace-flow',
    });
    expect(payload.discovered_values_limit).toBe(25);
    expect(mockCtx.mintToken).toHaveBeenCalledWith(
      [
        { type: 'PIPES:READ', resource: 'agent_usage_breakdown' },
        { type: 'PIPES:READ', resource: 'agent_repo_directory' },
      ],
      [],
      30,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const directoryCall = fetchSpy.mock.calls[3]![0] as string;
    expect(directoryCall).toContain('/v0/pipes/agent_repo_directory.json');
    expect(directoryCall).toContain('repos=repo_123');
    expect(directoryCall).toContain('limit=25');
  });

  it('can describe only the static contract', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await describeAgentAnalytics(
      mockCtx,
      [],
      {
        include_values: false,
      },
      30,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.filters.sources.allowed_values).toEqual(['claude', 'codex', 'cursor']);
    expect(payload.discovered_values).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockCtx.mintToken).not.toHaveBeenCalled();
  });

  it('reports more repo values from the bounded breakdown, not directory metadata', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              group_value: 'repo_123',
              message_count: 10,
              session_count: 2,
              total_tokens: 900,
              cost_usd: 0.45,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await describeAgentAnalytics(mockCtx, [], { limit: 1 }, 30);
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.discovered_values_may_have_more.repo_fingerprints).toBe(true);
  });

  it('queries summary with normalized filters and org-scoped token minting', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          {
            estimated_cost_usd: 2.5,
            total_tokens: 125000,
            message_count: 42,
            session_count: 4,
            priced_message_count: 40,
            coverage_pct: 0.9524,
          },
        ],
      }),
    );

    const result = await queryAgentAnalytics(
      mockCtx,
      [],
      {
        view: 'summary',
        hours: 168,
        filters: {
          sources: ['codex'],
          models: ['gpt-5.5'],
          repo_fingerprints: ['repo_123'],
        },
      },
      30,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.view).toBe('summary');
    expect(payload.data[0].total_tokens).toBe(125000);
    expect(mockCtx.mintToken).toHaveBeenCalledWith(
      [{ type: 'PIPES:READ', resource: 'agent_usage_summary' }],
      [],
      30,
    );

    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain('/v0/pipes/agent_usage_summary.json');
    expect(call).toContain('sources=codex');
    expect(call).toContain('models=gpt-5.5');
    expect(call).toContain('repos=repo_123');
  });

  it('queries timeseries with grouping controls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          {
            bucket_start: '2026-06-10 00:00:00',
            group_value: 'repo_123',
            total_tokens: 10,
            cost_usd: 0.001,
          },
        ],
      }),
    );

    const result = await queryAgentAnalytics(
      mockCtx,
      ['key-1'],
      {
        view: 'timeseries',
        group_by: 'repo',
        granularity: 'day',
      },
      7,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.view).toBe('timeseries');
    expect(payload.data[0].group_value).toBe('repo_123');
    expect(payload.pagination).toMatchObject({
      limit: 50,
      offset: 0,
      has_more: false,
    });

    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain('/v0/pipes/agent_usage_timeseries.json');
    expect(call).toContain('group_by=repo');
    expect(call).toContain('granularity=day');
    expect(call).toContain('limit=50');
    expect(call).toContain('offset=0');
  });

  it('queries context health with threshold and breakdown controls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          {
            group_value: 'repo_123',
            attention_threshold_tokens: 100000,
            model_call_count: 12,
            context_overage_tokens: 42000,
          },
        ],
      }),
    );

    const result = await queryAgentAnalytics(
      mockCtx,
      [],
      {
        view: 'context_health',
        dimension: 'repo',
        attention_threshold_tokens: 100000,
        filters: { models: ['gpt-5.5'], repo_fingerprints: ['repo_123'] },
        limit: 10,
      },
      30,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.view).toBe('context_health');
    expect(payload.data[0]).toMatchObject({
      group_value: 'repo_123',
      attention_threshold_tokens: 100000,
      context_overage_tokens: 42000,
    });
    expect(mockCtx.mintToken).toHaveBeenCalledWith(
      [{ type: 'PIPES:READ', resource: 'agent_context_health' }],
      [],
      30,
    );

    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain('/v0/pipes/agent_context_health.json');
    expect(call).toContain('dimension=repo');
    expect(call).toContain('attention_threshold_tokens=100000');
    expect(call).toContain('models=gpt-5.5');
    expect(call).toContain('repos=repo_123');
    expect(call).toContain('limit=10');
  });

  it('passes limit and offset for paged project rows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: Array.from({ length: 5 }, (_, i) => ({
          repo_fingerprint: `repo_${i + 10}`,
          normalized_git_remote: `github.com/example/repo-${i + 10}`,
          repo_path_fallback: `repo-${i + 10}`,
          repo_source: 'git_remote',
        })),
      }),
    );

    const result = await queryAgentAnalytics(
      mockCtx,
      [],
      {
        view: 'projects',
        limit: 5,
        offset: 10,
      },
      30,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.pagination).toMatchObject({
      limit: 5,
      offset: 10,
      has_more: true,
      next_offset: 15,
    });

    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain('/v0/pipes/agent_repo_directory.json');
    expect(call).toContain('limit=5');
    expect(call).toContain('offset=10');
  });

  it('queries review-unit costs with direct-link ordering controls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          {
            review_unit_key: 'hosted:github.com/acme/app:pull_request:42',
            review_url: 'https://github.com/acme/app/pull/42',
            estimated_cost_usd: 1.25,
            session_count: 2,
          },
        ],
      }),
    );

    const result = await queryAgentAnalytics(
      mockCtx,
      ['key-1'],
      {
        view: 'review_units',
        filters: { sources: ['codex'], repo_fingerprints: ['repo_123'] },
        order_by: 'recent',
        limit: 5,
        offset: 10,
      },
      30,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.view).toBe('review_units');
    expect(payload.data[0].review_url).toBe('https://github.com/acme/app/pull/42');
    expect(mockCtx.mintToken).toHaveBeenCalledWith(
      [{ type: 'PIPES:READ', resource: 'agent_review_unit_costs' }],
      ['key-1'],
      30,
    );

    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain('/v0/pipes/agent_review_unit_costs.json');
    expect(call).toContain('sources=codex');
    expect(call).toContain('repos=repo_123');
    expect(call).toContain('order_by=recent');
    expect(call).toContain('limit=5');
    expect(call).toContain('offset=10');
  });

  it('clamps oversized timeseries pages', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [],
      }),
    );

    const result = await queryAgentAnalytics(
      mockCtx,
      [],
      {
        view: 'timeseries',
        limit: 250,
      },
      30,
    );
    const payload = JSON.parse(result.content[0]!.text!);

    expect(payload.pagination.limit).toBe(50);
    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain('limit=50');
  });

  it('accepts ISO date ranges', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [],
      }),
    );

    const result = await queryAgentAnalytics(
      mockCtx,
      [],
      {
        view: 'projects',
        start_time: '2026-06-04T00:00:00Z',
        end_time: '2026-06-11T00:00:00Z',
      },
      30,
    );
    const payload = JSON.parse(result.content[0]!.text!);
    const startMs = Date.parse('2026-06-04T00:00:00Z');
    const endMs = Date.parse('2026-06-11T00:00:00Z');

    expect(payload.window.start_time_ms).toBe(startMs);
    expect(payload.window.end_time_ms).toBe(endMs);

    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain(`start_time_ms=${startMs}`);
    expect(call).toContain(`end_time_ms=${endMs}`);
  });

  it('ignores explicit date ranges outside the retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));

    const result = await queryAgentAnalytics(
      mockCtx,
      [],
      {
        view: 'projects',
        start_time: '1960-01-01T00:00:00Z',
        end_time: '2099-01-01T00:00:00Z',
      },
      7,
    );
    const payload = JSON.parse(result.content[0]!.text!);
    const endMs = Date.parse('2026-06-11T00:00:00Z');
    const startMs = Date.parse('2026-06-04T00:00:00Z');

    expect(payload.window.start_time_ms).toBe(startMs);
    expect(payload.window.end_time_ms).toBe(endMs);

    const call = fetchSpy.mock.calls[0]![0] as string;
    expect(call).toContain(`start_time_ms=${startMs}`);
    expect(call).toContain(`end_time_ms=${endMs}`);
  });

  it('returns a tool error for invalid ISO date ranges', async () => {
    const result = await queryAgentAnalytics(
      mockCtx,
      [],
      {
        view: 'summary',
        start_time: 'last thursday-ish',
      },
      30,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('start_time must be an ISO date/time string');
  });

  it('returns a tool error for unknown views', async () => {
    const result = await queryAgentAnalytics(mockCtx, [], { view: 'raw_sql' }, 7);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('view must be one of');
  });

  it('does not expose generic session browsing through MCP', async () => {
    const result = await queryAgentAnalytics(mockCtx, [], { view: 'sessions' }, 7);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('context_health');
    expect(result.content[0]!.text).not.toContain('sessions');
  });
});
