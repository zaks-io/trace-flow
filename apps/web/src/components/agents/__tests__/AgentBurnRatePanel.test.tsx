import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentBurnRatePanel } from '../AgentBurnRatePanel';
import type { AgentSummaryRow, AgentTimeseriesRow } from '../types';

function seriesRow(overrides: Partial<AgentTimeseriesRow> = {}): AgentTimeseriesRow {
  return {
    bucket_start: '2026-06-10 00:00:00',
    group_value: '',
    message_count: 10,
    session_count: 2,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 150,
    cost_usd: 20,
    priced_message_count: 10,
    tool_event_count: 0,
    tool_success_count: 0,
    tool_failure_count: 0,
    tool_unknown_count: 0,
    ...overrides,
  };
}

const summary: AgentSummaryRow = {
  estimated_cost_usd: 90,
  total_tokens: 9_000,
  message_count: 90,
  session_count: 9,
  priced_message_count: 90,
  coverage_pct: 1,
  prior_cost_usd: 45,
  prior_total_tokens: 4_500,
  prior_message_count: 45,
  prior_session_count: 5,
};

describe('AgentBurnRatePanel', () => {
  it('renders the burn-rate cells with fact labels', () => {
    const html = renderToStaticMarkup(
      <AgentBurnRatePanel
        summary={summary}
        currentRows={[
          seriesRow({ bucket_start: '2026-06-08 00:00:00' }),
          seriesRow({ bucket_start: '2026-06-09 00:00:00' }),
        ]}
        priorRows={[seriesRow({ bucket_start: '2026-06-05 00:00:00' })]}
        filterParams={{
          start_time_ms: Date.UTC(2026, 5, 8),
          end_time_ms: Date.UTC(2026, 5, 11),
        }}
      />,
    );

    expect(html).toContain('Burn Rate');
    expect(html).toContain('Daily spend');
    expect(html).toContain('Daily tokens');
    expect(html).toContain('Pace vs prior');
    expect(html).toContain('Projected 30-day cost');
    expect(html).toContain('Quiet days');
    expect(html).toContain('Weekday spend');
    expect(html).toContain('Sessions per active day');
  });

  it('does not invent active-day rates when current daily buckets fail', () => {
    const html = renderToStaticMarkup(
      <AgentBurnRatePanel
        summary={summary}
        currentRows={[]}
        priorRows={[]}
        currentError={new Error('Tinybird unavailable')}
        filterParams={{
          start_time_ms: Date.UTC(2026, 5, 8),
          end_time_ms: Date.UTC(2026, 5, 11),
        }}
      />,
    );

    expect(html).toContain('Daily spend');
    expect(html).toContain('Could not load');
    expect(html).toContain('Daily usage buckets are required for active-day cost.');
    expect(html).toContain('Quiet-day math needs daily usage buckets.');
    expect(html).not.toContain('/ active day');
  });

  it('does not invent active-day rates when current daily buckets have no active days', () => {
    const html = renderToStaticMarkup(
      <AgentBurnRatePanel
        summary={summary}
        currentRows={[]}
        priorRows={[]}
        filterParams={{
          start_time_ms: Date.UTC(2026, 5, 8),
          end_time_ms: Date.UTC(2026, 5, 11),
        }}
      />,
    );

    expect(html).toContain('Daily spend');
    expect(html).toContain('Could not load');
    expect(html).toContain('Daily usage buckets are required for active-day cost.');
    expect(html).toContain('window total loaded; daily projection is unavailable');
    expect(html).not.toContain('/ active day');
  });

  it('renders current rates while making prior comparison failure explicit', () => {
    const html = renderToStaticMarkup(
      <AgentBurnRatePanel
        summary={summary}
        currentRows={[
          seriesRow({ bucket_start: '2026-06-08 00:00:00' }),
          seriesRow({ bucket_start: '2026-06-09 00:00:00' }),
        ]}
        priorRows={[]}
        priorError={new Error('Tinybird unavailable')}
        filterParams={{
          start_time_ms: Date.UTC(2026, 5, 8),
          end_time_ms: Date.UTC(2026, 5, 11),
        }}
      />,
    );

    expect(html).toContain('$45.00 / active day');
    expect(html).toContain('Prior active-day pace: not loaded');
    expect(html).toContain('prior baseline not loaded');
  });

  it('does not invent prior active-day comparison rates from empty prior buckets', () => {
    const html = renderToStaticMarkup(
      <AgentBurnRatePanel
        summary={summary}
        currentRows={[
          seriesRow({ bucket_start: '2026-06-08 00:00:00' }),
          seriesRow({ bucket_start: '2026-06-09 00:00:00' }),
        ]}
        priorRows={[]}
        filterParams={{
          start_time_ms: Date.UTC(2026, 5, 8),
          end_time_ms: Date.UTC(2026, 5, 11),
        }}
      />,
    );

    expect(html).toContain('$45.00 / active day');
    expect(html).toContain('Prior active-day pace: not loaded');
    expect(html).toContain('prior baseline not loaded');
    expect(html).not.toContain('Prior active-day pace: $0.0000 / day');
  });
});
