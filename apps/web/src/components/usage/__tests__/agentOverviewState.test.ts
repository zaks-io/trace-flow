import { describe, expect, it } from 'vitest';
import type { AgentSummaryRow } from '@/components/agents/types';
import {
  hasAgentActivity,
  resolveAgentOverviewView,
  toAgentWindowParams,
} from '../agentOverviewState';

const summary: AgentSummaryRow = {
  estimated_cost_usd: 12.5,
  total_tokens: 4_000,
  message_count: 30,
  session_count: 3,
  priced_message_count: 24,
  coverage_pct: 0.8,
  prior_cost_usd: 10,
  prior_total_tokens: 3_000,
  prior_message_count: 20,
  prior_session_count: 2,
};

describe('toAgentWindowParams', () => {
  it('converts the minute-snapped nanosecond dashboard window to milliseconds', () => {
    const startMs = 1_700_000_040_000;
    const endMs = 1_700_086_440_000;
    expect(
      toAgentWindowParams({ startTimeNs: startMs * 1_000_000, endTimeNs: endMs * 1_000_000 }),
    ).toEqual({ start_time_ms: startMs, end_time_ms: endMs });
  });
});

describe('hasAgentActivity', () => {
  it('is false without a row or with zero turns and conversations', () => {
    expect(hasAgentActivity(null)).toBe(false);
    expect(hasAgentActivity({ ...summary, message_count: 0, session_count: 0 })).toBe(false);
  });

  it('is true when either turns or conversations exist', () => {
    expect(hasAgentActivity({ ...summary, message_count: 0 })).toBe(true);
    expect(hasAgentActivity({ ...summary, session_count: 0 })).toBe(true);
  });
});

describe('resolveAgentOverviewView', () => {
  it('surfaces errors even while loading or without data', () => {
    expect(resolveAgentOverviewView({ isLoading: true, hasError: true, summary: null })).toBe(
      'error',
    );
  });

  it('hides the section while loading', () => {
    expect(resolveAgentOverviewView({ isLoading: true, hasError: false, summary })).toBe('hidden');
  });

  it('hides the section for orgs with no agent activity in the window', () => {
    expect(resolveAgentOverviewView({ isLoading: false, hasError: false, summary: null })).toBe(
      'hidden',
    );
    expect(
      resolveAgentOverviewView({
        isLoading: false,
        hasError: false,
        summary: { ...summary, message_count: 0, session_count: 0 },
      }),
    ).toBe('hidden');
  });

  it('shows stats once activity has loaded', () => {
    expect(resolveAgentOverviewView({ isLoading: false, hasError: false, summary })).toBe('stats');
  });
});
