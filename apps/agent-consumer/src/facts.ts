/** Base fact category to Tinybird datasource. Order is the insert order. */
export const DATASOURCES = {
  messages: 'agent_message_facts',
  tool_events: 'agent_tool_event_facts',
  file_events: 'agent_file_event_facts',
  capability_snapshots: 'agent_capability_snapshot_facts',
  pull_request_links: 'agent_pull_request_facts',
} as const;

export const LEGACY_DATASOURCES: Record<keyof typeof DATASOURCES, string> = {
  messages: 'agent_messages',
  tool_events: 'agent_tool_events',
  file_events: 'agent_file_events',
  capability_snapshots: 'agent_capability_snapshots',
  pull_request_links: 'agent_pull_request_links',
};

export type Category = keyof typeof DATASOURCES;

export const CATEGORIES = Object.keys(DATASOURCES) as Category[];

export type Accumulator = Record<Category, unknown[]>;

export const ROW_IDENTITY_FIELDS: Record<Category, string[]> = {
  messages: ['OrgId', 'session_pk', 'message_pk'],
  tool_events: ['OrgId', 'session_pk', 'tool_use_pk'],
  file_events: ['OrgId', 'session_pk', 'file_event_pk'],
  capability_snapshots: ['OrgId', 'session_pk', 'capability_snapshot_pk'],
  pull_request_links: ['OrgId', 'session_pk', 'pull_request_link_pk'],
};

export function emptyAccumulator(): Accumulator {
  return {
    messages: [],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
  };
}

export function rowIdentity(row: unknown, keyFields: string[]): string {
  if (!isRecord(row)) {
    return stableStringify(row);
  }
  return keyFields.map((field) => identityPart(row[field])).join('\x1f');
}

export function rowOrgId(row: unknown): string {
  return isRecord(row) && typeof row.OrgId === 'string' ? row.OrgId : '';
}

export function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => key !== 'IngestedAt')
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function identityPart(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return stableStringify(value);
}
