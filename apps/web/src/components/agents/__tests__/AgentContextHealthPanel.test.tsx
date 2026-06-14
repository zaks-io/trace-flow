import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TinybirdResponse } from '@/components/usage/types';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { AgentContextHealthPanel } from '../AgentContextHealthPanel';
import type { AgentContextBreakdownDimension, AgentContextHealthRow } from '../types';

vi.mock('@/hooks/useTinybirdQuery', () => ({
  useTinybirdQuery: vi.fn(),
}));

const mockUseTinybirdQuery = vi.mocked(useTinybirdQuery);

function row(overrides: Partial<AgentContextHealthRow> = {}): AgentContextHealthRow {
  return {
    group_value: '',
    attention_threshold_tokens: 140_000,
    model_call_count: 10,
    prior_model_call_count: 4,
    session_count: 3,
    prior_session_count: 2,
    first_call_context_p50: 50_000,
    prior_first_call_context_p50: 40_000,
    context_p50: 80_000,
    prior_context_p50: 70_000,
    context_p90: 120_000,
    prior_context_p90: 110_000,
    context_p95: 130_000,
    prior_context_p95: 125_000,
    context_max: 135_000,
    prior_context_max: 130_000,
    calls_over_threshold: 0,
    prior_calls_over_threshold: 0,
    pct_calls_over_threshold: 0,
    prior_pct_calls_over_threshold: 0,
    sessions_over_threshold: 0,
    prior_sessions_over_threshold: 0,
    pct_sessions_over_threshold: 0,
    prior_pct_sessions_over_threshold: 0,
    context_overage_tokens: 0,
    prior_context_overage_tokens: 0,
    cost_while_over_threshold: 0,
    prior_cost_while_over_threshold: 0,
    output_tokens_while_over_threshold: 0,
    prior_output_tokens_while_over_threshold: 0,
    bloated_start_25k_sessions: 1,
    prior_bloated_start_25k_sessions: 0,
    pct_bloated_start_25k: 0.33,
    prior_pct_bloated_start_25k: 0,
    bloated_start_50k_sessions: 1,
    prior_bloated_start_50k_sessions: 0,
    pct_bloated_start_50k: 0.33,
    prior_pct_bloated_start_50k: 0,
    bloated_start_100k_sessions: 0,
    prior_bloated_start_100k_sessions: 0,
    pct_bloated_start_100k: 0,
    prior_pct_bloated_start_100k: 0,
    ...overrides,
  };
}

function queryResult(
  rows: AgentContextHealthRow[] | null,
  isLoading = false,
): ReturnType<typeof useTinybirdQuery<TinybirdResponse<AgentContextHealthRow>>> {
  return {
    data: rows ? { data: rows } : null,
    isLoading,
    isFetching: isLoading,
    error: null,
    refetch: vi.fn(),
    dataUpdatedAt: 0,
  } as ReturnType<typeof useTinybirdQuery<TinybirdResponse<AgentContextHealthRow>>>;
}

function renderPanel(rowValue: AgentContextHealthRow | null): string {
  return renderToStaticMarkup(
    <AgentContextHealthPanel
      row={rowValue}
      filterParams={{ start_time_ms: 1, end_time_ms: 2 }}
      models={[]}
      attentionThresholdTokens={140_000}
      labelFor={(value) => `repo:${value}`}
      selectedFor={(_dimension: AgentContextBreakdownDimension) => []}
      onToggle={vi.fn()}
    />,
  );
}

describe('AgentContextHealthPanel', () => {
  afterEach(() => {
    mockUseTinybirdQuery.mockReset();
  });

  it('renders an explicit empty state when the aggregate row is absent', () => {
    const html = renderPanel(null);

    expect(html).toContain('No measured context data for this range.');
    expect(html).toContain('0 measured calls');
    expect(mockUseTinybirdQuery).not.toHaveBeenCalled();
  });

  it('renders loading breakdowns without flashing the empty breakdown state', () => {
    mockUseTinybirdQuery.mockReturnValue(queryResult(null, true));

    const html = renderPanel(row());

    expect(html.match(/Loading context data/g)).toHaveLength(3);
    expect(html).not.toContain('No measured context data</p>');
  });

  it('renders normal aggregate metrics and populated breakdown rows', () => {
    mockUseTinybirdQuery.mockReturnValue(
      queryResult([row({ group_value: 'codex', context_overage_tokens: 0 })]),
    );

    const html = renderPanel(row());

    expect(html).toContain('Startup Floor');
    expect(html).toContain('50.0K tokens');
    expect(html).toContain('Attention Pressure');
    expect(html).toContain('0.0% calls');
    expect(html).toContain('By Source');
    expect(html).toContain('codex');
  });

  it('renders pressured metrics and overage burden', () => {
    mockUseTinybirdQuery.mockReturnValue(
      queryResult([
        row({
          group_value: 'repo-1',
          calls_over_threshold: 5,
          pct_calls_over_threshold: 0.5,
          context_overage_tokens: 250_000,
        }),
      ]),
    );

    const html = renderPanel(
      row({
        calls_over_threshold: 5,
        pct_calls_over_threshold: 0.5,
        sessions_over_threshold: 2,
        context_overage_tokens: 250_000,
        cost_while_over_threshold: 12.34,
      }),
    );

    expect(html).toContain('50% calls');
    expect(html).toContain('250.0K tokens');
    expect(html).toContain('$12.34');
    expect(html).toContain('repo:repo-1');
  });
});
