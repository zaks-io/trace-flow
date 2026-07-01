import { describe, expect, it } from 'vitest';
import {
  buildAgentSourceStatusItems,
  hasSyncedAgentSource,
  resolveAgentEmptyStateCopy,
  resolveAgentOrgTruthState,
} from '../sourceStatus';
import type { AgentSourceSyncStatusRow } from '../types';

function row(overrides: Partial<AgentSourceSyncStatusRow> = {}): AgentSourceSyncStatusRow {
  return {
    source: 'claude',
    collector_id: 'collector-a',
    last_ingested_ms: 1_779_278_400_000,
    last_successful_sync_ms: 1_779_278_400_000,
    last_event_ms: 1_779_256_800_000,
    message_count: 4,
    session_count: 1,
    tool_event_count: 2,
    ...overrides,
  };
}

describe('agent source sync status', () => {
  it('marks Claude/Codex as not connected and Cursor as unsupported for a never-synced org', () => {
    const items = buildAgentSourceStatusItems([]);

    expect(items.map((item) => [item.source, item.state])).toEqual([
      ['claude', 'not_connected'],
      ['codex', 'not_connected'],
      ['cursor', 'unsupported'],
    ]);
    expect(hasSyncedAgentSource(items)).toBe(false);
  });

  it('rolls up synced source metadata per source across collectors', () => {
    const items = buildAgentSourceStatusItems([
      row(),
      row({
        collector_id: 'collector-b',
        last_ingested_ms: 1_779_282_000_000,
        last_successful_sync_ms: 1_779_282_000_000,
        last_event_ms: 1_779_260_400_000,
        message_count: 3,
        session_count: 2,
        tool_event_count: 5,
      }),
      row({
        source: 'codex',
        collector_id: 'collector-a',
        message_count: 1,
        session_count: 1,
        tool_event_count: 0,
      }),
    ]);

    expect(items[0]).toMatchObject({
      source: 'claude',
      state: 'synced',
      collectorCount: 2,
      lastIngestedMs: 1_779_282_000_000,
      lastSuccessfulSyncMs: 1_779_282_000_000,
      lastEventMs: 1_779_260_400_000,
      messageCount: 7,
      sessionCount: 3,
      toolEventCount: 7,
    });
    expect(items[1]).toMatchObject({ source: 'codex', state: 'synced' });
    expect(items[2]).toMatchObject({ source: 'cursor', state: 'unsupported' });
    expect(hasSyncedAgentSource(items)).toBe(true);
  });

  it('distinguishes never-synced, zero-in-range, and filtered empty states', () => {
    expect(resolveAgentOrgTruthState({ hasFilters: false, hasSyncedSource: false })).toBe(
      'never_synced',
    );
    expect(resolveAgentOrgTruthState({ hasFilters: false, hasSyncedSource: true })).toBe(
      'zero_in_range',
    );
    expect(resolveAgentOrgTruthState({ hasFilters: true, hasSyncedSource: true })).toBe(
      'filtered_empty',
    );

    expect(resolveAgentEmptyStateCopy('never_synced')).toMatchObject({
      title: 'No collector has synced yet',
      showCliCta: true,
    });
    expect(resolveAgentEmptyStateCopy('zero_in_range')).toMatchObject({
      title: 'No CLI-ingested activity in this range',
      showCliCta: false,
    });
    expect(resolveAgentEmptyStateCopy('filtered_empty')).toMatchObject({
      title: 'No agent activity for these filters',
      showCliCta: false,
    });
  });
});
