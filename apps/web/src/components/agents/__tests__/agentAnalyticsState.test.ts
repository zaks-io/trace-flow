import { describe, expect, it } from 'vitest';
import {
  hasLoadedAgentData,
  hasLoadedAgentDetailData,
  resolveAgentMainView,
  shouldShowAgentEmptyState,
} from '../agentAnalyticsState';

const baseView = {
  isLoading: false,
  hasError: false,
  hasAnyLoadedData: false,
  shouldShowEmptyState: false,
  hasSummary: true,
  summaryFailed: false,
};

const emptyState = {
  summary: null,
  timeseries: [],
  contextHealth: null,
  failures: [],
  deltas: [],
};

describe('agent analytics state', () => {
  it('counts tool delta rows as loaded data for partial-load rendering', () => {
    expect(hasLoadedAgentData({ ...emptyState, deltas: [{ tool_name: 'bash' }] })).toBe(true);
  });

  it('returns false when every surface is empty', () => {
    expect(hasLoadedAgentData(emptyState)).toBe(false);
  });

  it('separates summary-only data from detail sections', () => {
    expect(hasLoadedAgentData({ ...emptyState, summary: { message_count: 0 } })).toBe(true);
    expect(hasLoadedAgentDetailData({ ...emptyState, deltas: [{ tool_name: 'bash' }] })).toBe(true);
    expect(hasLoadedAgentDetailData(emptyState)).toBe(false);
  });

  it('does not show the global empty state during partial-load rendering', () => {
    expect(
      shouldShowAgentEmptyState({
        isEmpty: true,
        hasError: new Error('Tinybird unavailable'),
        hasLoadedData: true,
        hasLoadedDetailData: false,
      }),
    ).toBe(false);
  });

  it('does not show the global empty state when detail rows exist', () => {
    expect(
      shouldShowAgentEmptyState({
        isEmpty: true,
        hasError: null,
        hasLoadedData: true,
        hasLoadedDetailData: true,
      }),
    ).toBe(false);
  });

  it('shows the global empty state for a clean empty summary', () => {
    expect(
      shouldShowAgentEmptyState({
        isEmpty: true,
        hasError: null,
        hasLoadedData: true,
        hasLoadedDetailData: false,
      }),
    ).toBe(true);
  });
});

describe('resolveAgentMainView', () => {
  it('shows loading first, before any other state', () => {
    expect(
      resolveAgentMainView({
        ...baseView,
        isLoading: true,
        hasSummary: false,
        summaryFailed: true,
      }),
    ).toBe('loading');
  });

  it('renders error-only when a total failure loaded nothing', () => {
    expect(
      resolveAgentMainView({
        ...baseView,
        hasError: true,
        hasAnyLoadedData: false,
        hasSummary: false,
      }),
    ).toBe('error');
  });

  it('does NOT show the empty state when the summary failed but other surfaces loaded', () => {
    // Regression: a summary query error left `summary` null while detail data populated, and the
    // page misrendered "No agent activity yet" instead of the failure banner.
    expect(
      resolveAgentMainView({
        ...baseView,
        hasError: true,
        hasAnyLoadedData: true,
        summaryFailed: true,
        hasSummary: false,
      }),
    ).toBe('error');
  });

  it('shows the empty state for a genuinely empty workspace (summary loaded, no rows)', () => {
    expect(
      resolveAgentMainView({ ...baseView, shouldShowEmptyState: true, hasSummary: false }),
    ).toBe('empty');
  });

  it('renders the grid when the summary loaded with data', () => {
    expect(resolveAgentMainView({ ...baseView, hasAnyLoadedData: true })).toBe('grid');
  });
});
