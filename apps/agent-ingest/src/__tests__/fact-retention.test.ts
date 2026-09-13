import { describe, expect, it } from 'vitest';
import { retainAgentAnalyticsFacts } from '../fact-retention';
import { facts } from './factories';

const DAY_MS = 24 * 60 * 60 * 1_000;
const TODAY = Date.UTC(2026, 8, 13);

describe('agent fact retention', () => {
  it('matches the coordinator window of today plus the previous 365 UTC days', () => {
    const oldest = Date.parse('2025-09-13T00:00:00.000Z');
    const input = facts();
    input.messages[0]!.event_at = oldest - 1;
    input.tool_events[0]!.event_at = oldest;
    input.file_events[0]!.event_at = TODAY;
    input.capability_snapshots[0]!.event_at = TODAY + DAY_MS - 1;
    input.pull_request_links[0]!.event_at = oldest - DAY_MS;

    const retained = retainAgentAnalyticsFacts(input, TODAY + 1_000);

    expect(retained.excludedByRetention).toBe(2);
    expect(retained.facts.messages).toEqual([]);
    expect(retained.facts.pull_request_links).toEqual([]);
    expect(retained.facts.tool_events).toHaveLength(1);
    expect(retained.facts.file_events).toHaveLength(1);
    expect(retained.facts.capability_snapshots).toHaveLength(1);
  });

  it('allows same-day collector clock skew and rejects the next UTC day', () => {
    const sameDay = facts();
    sameDay.messages[0]!.event_at = TODAY + DAY_MS - 1;
    expect(() => retainAgentAnalyticsFacts(sameDay, TODAY)).not.toThrow();

    const futureDay = facts();
    futureDay.messages[0]!.event_at = TODAY + DAY_MS;
    expect(() => retainAgentAnalyticsFacts(futureDay, TODAY)).toThrow(
      'dated after the current UTC day',
    );
  });
});
