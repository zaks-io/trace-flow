import { agentAnalyticsDayBounds } from '@trace-flow/utils';
import type { AgentIngestFacts } from '@trace-flow/types';

export class FutureAgentFactTimestampError extends Error {
  constructor(readonly category: keyof AgentIngestFacts) {
    super(`Agent ${category} fact is dated after the current UTC day`);
    this.name = 'FutureAgentFactTimestampError';
  }
}

export function retainAgentAnalyticsFacts(
  facts: AgentIngestFacts,
  now: number,
): { facts: AgentIngestFacts; excludedByRetention: number } {
  const { oldestDayStart, tomorrowStart } = agentAnalyticsDayBounds(now);
  let excludedByRetention = 0;

  const retain = <T extends { event_at: number }>(
    category: keyof AgentIngestFacts,
    rows: T[],
  ): T[] =>
    rows.filter((row) => {
      if (!Number.isSafeInteger(row.event_at) || row.event_at < 0) {
        throw new Error(`Agent ${category} fact has an invalid timestamp`);
      }
      if (row.event_at >= tomorrowStart) throw new FutureAgentFactTimestampError(category);
      if (row.event_at < oldestDayStart) {
        excludedByRetention += 1;
        return false;
      }
      return true;
    });

  return {
    facts: {
      messages: retain('messages', facts.messages),
      tool_events: retain('tool_events', facts.tool_events),
      file_events: retain('file_events', facts.file_events),
      capability_snapshots: retain('capability_snapshots', facts.capability_snapshots),
      pull_request_links: retain('pull_request_links', facts.pull_request_links),
    },
    excludedByRetention,
  };
}
