import { AGENT_FILTER_SOURCES, AGENT_SOURCES, type AgentSourceSyncStatusRow } from './types';

const SUPPORTED_SOURCE_SET = new Set<string>(AGENT_FILTER_SOURCES);

export type AgentSourceStatusState = 'synced' | 'not_connected' | 'unsupported';
export type AgentOrgTruthState = 'filtered_empty' | 'never_synced' | 'zero_in_range';

export interface AgentSourceStatusItem {
  source: string;
  state: AgentSourceStatusState;
  collectorCount: number;
  lastIngestedMs: number | null;
  lastSuccessfulSyncMs: number | null;
  lastEventMs: number | null;
  messageCount: number;
  sessionCount: number;
  toolEventCount: number;
}

interface SourceAggregate {
  collectorIds: Set<string>;
  lastIngestedMs: number | null;
  lastSuccessfulSyncMs: number | null;
  lastEventMs: number | null;
  messageCount: number;
  sessionCount: number;
  toolEventCount: number;
}

export function buildAgentSourceStatusItems(
  rows: readonly AgentSourceSyncStatusRow[],
): AgentSourceStatusItem[] {
  const aggregates = new Map<string, SourceAggregate>();

  for (const row of rows) {
    const source = row.source.trim().toLowerCase();
    if (!source) continue;

    const aggregate = aggregates.get(source) ?? {
      collectorIds: new Set<string>(),
      lastIngestedMs: null,
      lastSuccessfulSyncMs: null,
      lastEventMs: null,
      messageCount: 0,
      sessionCount: 0,
      toolEventCount: 0,
    };

    if (row.collector_id) aggregate.collectorIds.add(row.collector_id);
    aggregate.lastIngestedMs = maxNullable(aggregate.lastIngestedMs, row.last_ingested_ms);
    aggregate.lastSuccessfulSyncMs = maxNullable(
      aggregate.lastSuccessfulSyncMs,
      row.last_successful_sync_ms,
    );
    aggregate.lastEventMs = maxNullable(aggregate.lastEventMs, row.last_event_ms);
    aggregate.messageCount += row.message_count;
    aggregate.sessionCount += row.session_count;
    aggregate.toolEventCount += row.tool_event_count;
    aggregates.set(source, aggregate);
  }

  return AGENT_SOURCES.map((source) => {
    if (!SUPPORTED_SOURCE_SET.has(source)) {
      return emptyItem(source, 'unsupported');
    }

    const aggregate = aggregates.get(source);
    if (!aggregate) return emptyItem(source, 'not_connected');

    return {
      source,
      state: 'synced',
      collectorCount: aggregate.collectorIds.size,
      lastIngestedMs: aggregate.lastIngestedMs,
      lastSuccessfulSyncMs: aggregate.lastSuccessfulSyncMs,
      lastEventMs: aggregate.lastEventMs,
      messageCount: aggregate.messageCount,
      sessionCount: aggregate.sessionCount,
      toolEventCount: aggregate.toolEventCount,
    };
  });
}

export function hasSyncedAgentSource(items: readonly AgentSourceStatusItem[]): boolean {
  return items.some((item) => item.state === 'synced');
}

export function resolveAgentOrgTruthState({
  hasFilters,
  hasSyncedSource,
}: {
  hasFilters: boolean;
  hasSyncedSource: boolean;
}): AgentOrgTruthState {
  if (hasFilters) return 'filtered_empty';
  return hasSyncedSource ? 'zero_in_range' : 'never_synced';
}

export function resolveAgentEmptyStateCopy(state: AgentOrgTruthState): {
  title: string;
  description: string;
  showCliCta: boolean;
} {
  if (state === 'filtered_empty') {
    return {
      title: 'No agent activity for these filters',
      description: 'No CLI-ingested agent sessions match the current filters and time range.',
      showCliCta: false,
    };
  }

  if (state === 'zero_in_range') {
    return {
      title: 'No CLI-ingested activity in this range',
      description:
        'Trace Flow has seen collector syncs, but none of the synced Claude or Codex sessions fall inside this time range.',
      showCliCta: false,
    };
  }

  return {
    title: 'No collector has synced yet',
    description:
      'Install the production Trace Flow CLI, log in, and sync Claude or Codex transcripts to populate this dashboard.',
    showCliCta: true,
  };
}

function emptyItem(source: string, state: AgentSourceStatusState): AgentSourceStatusItem {
  return {
    source,
    state,
    collectorCount: 0,
    lastIngestedMs: null,
    lastSuccessfulSyncMs: null,
    lastEventMs: null,
    messageCount: 0,
    sessionCount: 0,
    toolEventCount: 0,
  };
}

function maxNullable(current: number | null, next: number): number | null {
  if (!Number.isFinite(next) || next <= 0) return current;
  return current == null ? next : Math.max(current, next);
}
