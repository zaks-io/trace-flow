import type { AgentSummaryRow } from '@/components/agents/types';

export type AgentOverviewView = 'hidden' | 'error' | 'stats';

/** The dashboard keeps nanosecond windows; agent pipes take milliseconds. */
export function toAgentWindowParams({
  startTimeNs,
  endTimeNs,
}: {
  startTimeNs: number;
  endTimeNs: number;
}): { start_time_ms: number; end_time_ms: number } {
  return {
    start_time_ms: Math.floor(startTimeNs / 1_000_000),
    end_time_ms: Math.floor(endTimeNs / 1_000_000),
  };
}

/** Same emptiness rule as the agents page: no billable turns and no conversations. */
export function hasAgentActivity(summary: AgentSummaryRow | null): summary is AgentSummaryRow {
  return summary != null && (summary.message_count > 0 || summary.session_count > 0);
}

/**
 * Failures always surface (never hidden silently); the section only disappears while
 * loading or when the org has no agent activity in the window.
 */
export function resolveAgentOverviewView({
  isLoading,
  hasError,
  summary,
}: {
  isLoading: boolean;
  hasError: boolean;
  summary: AgentSummaryRow | null;
}): AgentOverviewView {
  if (hasError) return 'error';
  if (isLoading || !hasAgentActivity(summary)) return 'hidden';
  return 'stats';
}
