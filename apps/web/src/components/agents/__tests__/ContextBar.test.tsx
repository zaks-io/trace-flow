import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TinybirdResponse } from '@/components/usage/types';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { ContextBar } from '../ContextBar';
import type { AgentBreakdownDimension, AgentBreakdownRow } from '../types';

vi.mock('@/hooks/useTinybirdQuery', () => ({
  useTinybirdQuery: vi.fn(),
}));

const mockUseTinybirdQuery = vi.mocked(useTinybirdQuery);

function row(group: string, cost: number): AgentBreakdownRow {
  return {
    group_value: group,
    message_count: cost,
    session_count: cost,
    total_tokens: cost,
    cost_usd: cost,
  };
}

function queryResult(
  rows: AgentBreakdownRow[],
): ReturnType<typeof useTinybirdQuery<TinybirdResponse<AgentBreakdownRow>>> {
  return {
    data: { data: rows },
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
    dataUpdatedAt: 0,
  } as ReturnType<typeof useTinybirdQuery<TinybirdResponse<AgentBreakdownRow>>>;
}

function renderBar(rows: AgentBreakdownRow[]): string {
  mockUseTinybirdQuery.mockReturnValue(queryResult(rows));

  return renderToStaticMarkup(
    <ContextBar
      filterParams={{ start_time_ms: 1, end_time_ms: 2 }}
      labelFor={(value) => `repo:${value}`}
      selectedFor={(_dimension: AgentBreakdownDimension) => []}
      onToggle={vi.fn()}
    />,
  );
}

describe('ContextBar', () => {
  afterEach(() => {
    mockUseTinybirdQuery.mockReset();
  });

  it('requests and renders a bounded top-10 breakdown without fabricating Other', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`repo-${i + 1}`, 10 - i));

    const html = renderBar(rows);

    expect(mockUseTinybirdQuery).toHaveBeenCalledWith({
      pipe: 'agent_usage_breakdown',
      params: {
        start_time_ms: 1,
        end_time_ms: 2,
        dimension: 'repo',
        order_by: 'cost_usd',
        limit: 10,
      },
    });
    expect(html).toContain('Top 10 cost by repo');
    expect(html).toContain('repo:repo-7');
    expect(html).toContain('repo:repo-10');
    expect(html).not.toContain('Other');
    expect(html).not.toContain('Aggregated lower-ranked groups');
  });

  it('renders only the visible top 10 when more rows are supplied', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`repo-${i + 1}`, 12 - i));

    const html = renderBar(rows);

    expect(html).toContain('repo:repo-10');
    expect(html).not.toContain('repo:repo-11');
    expect(html).not.toContain('repo:repo-12');
  });
});
