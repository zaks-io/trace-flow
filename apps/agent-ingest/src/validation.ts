import type { AgentIngestEnvelope } from '@trace-flow/types';

const FACT_CATEGORIES = [
  'messages',
  'tool_events',
  'file_events',
  'capability_snapshots',
  'pull_request_links',
] as const;
type Category = (typeof FACT_CATEGORIES)[number];

const BATCH_STRING_FIELDS = [
  'source',
  'parser_version',
  'desktop_version',
  'collector_batch_id',
] as const;

type FieldKind = 'string' | 'number' | 'nullableString';

/**
 * Per-category required fields, scoped to exactly what `reRedact()` and `assembleQueueFacts()`
 * dereference. This is the trust-boundary contract the handler needs — not full schema validation
 * (the consumer's Tinybird quarantine is the schema gate). A missing field here would otherwise feed
 * `undefined` into `capExcerpt`/the id hashers and surface as a 500 instead of the intended 400.
 */
const FACT_FIELD_KINDS: Record<Category, Record<string, FieldKind>> = {
  messages: {
    vendor_session_id: 'string',
    vendor_message_id: 'nullableString',
    turn_index: 'number',
    event_at: 'number',
    normalized_git_remote: 'string',
    repo_path_fallback: 'string',
  },
  tool_events: {
    vendor_session_id: 'string',
    vendor_message_id: 'nullableString',
    tool_use_id: 'nullableString',
    source_block_index: 'number',
    event_at: 'number',
    command_excerpt: 'string',
    error_excerpt: 'string',
  },
  file_events: {
    vendor_session_id: 'string',
    vendor_message_id: 'nullableString',
    normalized_repo_path: 'string',
    operation: 'string',
    source_block_index: 'number',
    event_at: 'number',
  },
  capability_snapshots: {
    vendor_session_id: 'string',
    source_snapshot_id: 'nullableString',
    stable_turn_index: 'number',
    event_at: 'number',
  },
  pull_request_links: {
    vendor_session_id: 'string',
    source_event_id: 'nullableString',
    stable_turn_index: 'number',
    event_at: 'number',
    url: 'string',
  },
};

function fieldValid(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'nullableString':
      return value === null || typeof value === 'string';
  }
}

/**
 * Structural guard at the trust boundary. The truthy `batch`/`facts` check is not enough — a
 * well-formed-but-empty `{batch:{},facts:{}}` (or a `tool_events: [{}]`) would pass it and then throw
 * downstream into a 500. This asserts the fields this handler dereferences and returns the first
 * offending path, or `null` if the shape is usable.
 */
export function validateEnvelopeShape(envelope: AgentIngestEnvelope | undefined): string | null {
  if (!envelope?.batch || typeof envelope.batch !== 'object') return 'batch';
  if (!envelope.facts || typeof envelope.facts !== 'object') return 'facts';
  for (const field of BATCH_STRING_FIELDS) {
    if (typeof envelope.batch[field] !== 'string') return `batch.${field}`;
  }
  for (const category of FACT_CATEGORIES) {
    const rows = envelope.facts[category];
    if (!Array.isArray(rows)) return `facts.${category}`;
    const kinds = FACT_FIELD_KINDS[category];
    for (let i = 0; i < rows.length; i++) {
      const row: unknown = rows[i];
      if (typeof row !== 'object' || row === null) return `facts.${category}[${i}]`;
      const rec = row as Record<string, unknown>;
      for (const [field, kind] of Object.entries(kinds)) {
        if (!fieldValid(rec[field], kind)) return `facts.${category}[${i}].${field}`;
      }
    }
  }
  return null;
}
