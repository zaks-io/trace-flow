import { describe, expect, it } from 'vitest';
import {
  hasLoadedAgentData,
  hasLoadedAgentDetailData,
  shouldShowAgentEmptyState,
} from '../agentAnalyticsState';

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
