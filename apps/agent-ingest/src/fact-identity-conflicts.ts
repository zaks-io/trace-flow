import type { AgentIngestQueueFacts } from '@trace-flow/types';

type QueueFactCategory = keyof AgentIngestQueueFacts;

const IDENTITY_FIELDS = {
  messages: 'message_pk',
  tool_events: 'tool_use_pk',
  file_events: 'file_event_pk',
  capability_snapshots: 'capability_snapshot_pk',
  pull_request_links: 'pull_request_link_pk',
  review_unit_attributions: 'review_unit_attribution_pk',
} as const satisfies Record<QueueFactCategory, string>;

export class AgentFactIdentityConflictError extends Error {
  constructor(readonly category: QueueFactCategory) {
    super(`Agent ${category} contains conflicting values for one identity`);
    this.name = 'AgentFactIdentityConflictError';
  }
}

/** One delivery revision cannot safely contain two values for the same natural identity. */
export function normalizeAgentFactIdentities(facts: AgentIngestQueueFacts): AgentIngestQueueFacts {
  return Object.fromEntries(
    Object.entries(IDENTITY_FIELDS).map(([category, identityField]) => [
      category,
      collapseFacts(
        facts[category as QueueFactCategory] as unknown[],
        category as QueueFactCategory,
        identityField,
      ),
    ]),
  ) as unknown as AgentIngestQueueFacts;
}

function collapseFacts(
  rows: unknown[],
  category: QueueFactCategory,
  identityField: string,
): unknown[] {
  const accepted: unknown[] = [];
  const factByIdentity = new Map<string, unknown>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      accepted.push(row);
      continue;
    }
    const value = row as Record<string, unknown>;
    if (typeof value.session_pk !== 'string' || typeof value[identityField] !== 'string') {
      accepted.push(row);
      continue;
    }
    const identity = JSON.stringify([value.session_pk, value[identityField]]);
    const previous = factByIdentity.get(identity);
    if (previous === undefined) {
      factByIdentity.set(identity, row);
      accepted.push(row);
    } else if (canonicalJson(previous) !== canonicalJson(row)) {
      throw new AgentFactIdentityConflictError(category);
    }
  }
  return accepted;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
