import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TinybirdResponse } from '@/components/usage/types';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { getFreshFirstRow, getFreshRows, useAgentData } from '../useAgentData';

vi.mock('@/hooks/useTinybirdQuery', () => ({ useTinybirdQuery: vi.fn() }));

function readAgentData() {
  let result: ReturnType<typeof useAgentData> | undefined;
  function Probe() {
    result = useAgentData({
      filterParams: { start_time_ms: 0, end_time_ms: 90 * 86_400_000 },
      groupBy: 'none',
      granularity: 'auto',
      usageGroupBy: 'repo',
      models: [],
      attentionThresholdTokens: 1000,
      spendDetailEnabled: true,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!result) throw new Error('Agent data probe did not render');
  return result;
}

type Row = { value: number };

function snapshot(data: Row[] | null, error: Error | null) {
  return {
    data: data ? ({ data } satisfies TinybirdResponse<Row>) : null,
    error,
  };
}

describe('useAgentData helpers', () => {
  it('suppresses stale rows when the latest query failed', () => {
    const query = snapshot([{ value: 1 }], new Error('Tinybird unavailable'));

    expect(getFreshRows(query)).toEqual([]);
    expect(getFreshFirstRow(query)).toBeNull();
  });

  it('returns rows from the latest successful query', () => {
    const query = snapshot([{ value: 1 }], null);

    expect(getFreshRows(query)).toEqual([{ value: 1 }]);
    expect(getFreshFirstRow(query)).toEqual({ value: 1 });
  });
});

describe('useAgentData query failures', () => {
  beforeEach(() => {
    vi.mocked(useTinybirdQuery).mockReset();
    vi.mocked(useTinybirdQuery).mockReturnValue({
      data: { data: [] },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });
  });

  it('reports a priciest-conversations-only failure as the banner error', () => {
    const error = new Error('Priciest conversations unavailable');
    vi.mocked(useTinybirdQuery).mockImplementation(({ pipe }) => ({
      data: { data: [] },
      error: pipe === 'agent_sessions_browser' ? error : null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    }));

    const result = readAgentData();

    expect(result.hasError).toBe(error);
    expect(result.failedSurfaces).toEqual([
      { id: 'topSessions', label: 'priciest conversations', error },
    ]);
    expect(result.topSessions).toEqual([]);
  });

  it('returns the first failed-surface Error when several queries fail', () => {
    const error = new Error('Analytics unavailable');
    vi.mocked(useTinybirdQuery).mockReturnValue({
      data: null,
      error,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });

    const result = readAgentData();

    expect(result.failedSurfaces).toHaveLength(14);
    expect(result.hasError).toBe(result.failedSurfaces[0].error);
  });

  it('returns null when no queries fail and requests local day burn buckets for long ranges', () => {
    const result = readAgentData();

    expect(result.hasError).toBeNull();
    expect(result.failedSurfaces).toEqual([]);
    const timeseriesCalls = vi
      .mocked(useTinybirdQuery)
      .mock.calls.map(([options]) => options)
      .filter(({ pipe }) => pipe === 'agent_usage_timeseries');
    expect(timeseriesCalls.map(({ params }) => params?.granularity)).toEqual([
      undefined,
      'day',
      'day',
      'day',
    ]);
    expect(timeseriesCalls.every(({ params }) => params?.timezone === result.timezone)).toBe(true);
  });
});
