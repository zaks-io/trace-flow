import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TinybirdResponse } from '@/components/usage/types';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { AgentContextHealthPanel, ContextBreakdownGrid } from '../AgentContextHealthPanel';
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
  options: { isLoading?: boolean; error?: Error | null } = {},
): ReturnType<typeof useTinybirdQuery<TinybirdResponse<AgentContextHealthRow>>> {
  const isLoading = options.isLoading ?? false;
  return {
    data: rows ? { data: rows } : null,
    isLoading,
    isFetching: isLoading,
    error: options.error ?? null,
    refetch: vi.fn(),
    dataUpdatedAt: 0,
  } as ReturnType<typeof useTinybirdQuery<TinybirdResponse<AgentContextHealthRow>>>;
}

function renderPanel(rowValue: AgentContextHealthRow | null, error: Error | null = null): string {
  return renderToStaticMarkup(
    <AgentContextHealthPanel
      row={rowValue}
      error={error}
      filterParams={{ start_time_ms: 1, end_time_ms: 2 }}
      models={[]}
      attentionThresholdTokens={140_000}
      labelFor={(value) => `repo:${value}`}
      selectedFor={(_dimension: AgentContextBreakdownDimension) => []}
      onToggle={vi.fn()}
    />,
  );
}

// The per-dimension breakdown queries live inside a collapsed-by-default subsection, so they only
// mount once a user expands it. Render the grid directly to assert query wiring and row rendering.
function renderGrid(): string {
  return renderToStaticMarkup(
    <ContextBreakdownGrid
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

    expect(html).toContain('Typical conversation start size');
    expect(html).toContain('Conversations crossing 140,000');
    expect(html).toContain('Time spent above 140,000');
    expect(html).toContain('Cost above 140,000');
    expect(html).toContain('No measured conversation-size data for this range.');
    expect(html).toContain('0 model requests measured');
    expect(mockUseTinybirdQuery).not.toHaveBeenCalled();
  });

  it('renders a failed aggregate state distinctly from empty data', () => {
    const html = renderPanel(null, new Error('Tinybird unavailable'));

    expect(html).toContain('Typical conversation start size');
    expect(html).toContain('Could not load');
    expect(html).toContain('Requests over 140,000 were not loaded');
    expect(html).toContain('Could not load conversation-size data for this range.');
    expect(html).not.toContain('No measured conversation-size data for this range.');
    expect(mockUseTinybirdQuery).not.toHaveBeenCalled();
  });

  it('renders loading breakdowns without flashing the empty breakdown state', () => {
    mockUseTinybirdQuery.mockReturnValue(queryResult(null, { isLoading: true }));

    const html = renderGrid();

    expect(html.match(/Loading context data/g)).toHaveLength(3);
    expect(html).not.toContain('No measured context data</p>');
  });

  it('renders breakdown query failures distinctly from empty data', () => {
    mockUseTinybirdQuery.mockReturnValue(
      queryResult(null, { error: new Error('Tinybird unavailable') }),
    );

    const html = renderGrid();

    expect(html.match(/Could not load context breakdown/g)).toHaveLength(3);
    expect(html).not.toContain('No measured context data</p>');
  });

  it('renders normal aggregate metrics', () => {
    mockUseTinybirdQuery.mockReturnValue(queryResult([]));

    const html = renderPanel(row());

    expect(html).toContain('Conversation Size');
    expect(html).toContain('Large-conversation threshold: 140,000');
    expect(html).toContain('Typical conversation start size');
    expect(html).toContain('50.0K tokens');
    expect(html).toContain('Conversations crossing 140,000');
    expect(html).toContain('0 / 2 conversations');
    expect(html).toContain('Conversation start sizes');
    expect(html).toContain('Start size &gt;= 25K');
  });

  it('renders populated breakdown rows', () => {
    mockUseTinybirdQuery.mockReturnValue(
      queryResult([
        row({
          group_value: 'codex',
          calls_over_threshold: 1,
          pct_calls_over_threshold: 0.1,
          context_overage_tokens: 10_000,
        }),
      ]),
    );

    const html = renderGrid();

    expect(html).toContain('By Source');
    expect(html).toContain('codex');
    expect(html).toContain('1 / 10 model requests over 140,000');
  });

  it('renders over-threshold metrics and cost', () => {
    mockUseTinybirdQuery.mockReturnValue(queryResult([]));

    const html = renderPanel(
      row({
        calls_over_threshold: 5,
        pct_calls_over_threshold: 0.5,
        sessions_over_threshold: 2,
        context_overage_tokens: 250_000,
        cost_while_over_threshold: 12.34,
      }),
    );

    expect(html).toContain('2 / 3 conversations');
    expect(html).toContain('5 / 10 model requests over 140,000');
    expect(html).toContain('250.0K tokens');
    expect(html).toContain('$12.34');
  });

  it('resolves repo labels in breakdown rows', () => {
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

    const html = renderGrid();

    expect(html).toContain('repo:repo-1');
  });

  it('requests at most 10 breakdown rows per dimension', () => {
    mockUseTinybirdQuery.mockReturnValue(queryResult([]));

    renderGrid();

    expect(mockUseTinybirdQuery).toHaveBeenCalledTimes(3);
    for (const call of mockUseTinybirdQuery.mock.calls) {
      expect(call[0].params).toMatchObject({ limit: 10 });
    }
  });

  it('hides zero-over-threshold breakdown rows', () => {
    mockUseTinybirdQuery.mockReturnValue(
      queryResult([row({ group_value: 'claude', context_overage_tokens: 0 })]),
    );

    const html = renderGrid();

    expect(html).not.toContain('claude');
    expect(html).toContain('No model requests over 140,000 tokens sent before the reply');
  });
});
