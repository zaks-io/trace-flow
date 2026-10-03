import type { AgentIngestQueueFacts } from '@trace-flow/types';

type QueueFactCategory = keyof AgentIngestQueueFacts;

/**
 * `identity` names the row's natural-key column. `position` names a field that only feeds that key
 * when `sourceId` is null (see `ids.ts`); once the vendor id supplied the key, the position is just
 * where the Collector saw the row, so it cannot make two rows with one identity disagree.
 */
interface IdentityRule {
  identity: string;
  position?: { field: string; sourceId: string };
}

const IDENTITY_RULES = {
  messages: {
    identity: 'message_pk',
    position: { field: 'turn_index', sourceId: 'vendor_message_id' },
  },
  tool_events: {
    identity: 'tool_use_pk',
    position: { field: 'source_block_index', sourceId: 'tool_use_id' },
  },
  file_events: { identity: 'file_event_pk' },
  capability_snapshots: {
    identity: 'capability_snapshot_pk',
    position: { field: 'stable_turn_index', sourceId: 'source_snapshot_id' },
  },
  pull_request_links: {
    identity: 'pull_request_link_pk',
    position: { field: 'stable_turn_index', sourceId: 'source_event_id' },
  },
  review_unit_attributions: { identity: 'review_unit_attribution_pk' },
} as const satisfies Record<QueueFactCategory, IdentityRule>;

export interface FactIdentityConflict {
  vendorSessionId: string;
  /** The row's `*_pk`, already a SHA-256-derived id, so it is safe to log. */
  identityPk: string;
}

export class AgentFactIdentityConflictError extends Error {
  constructor(
    readonly category: QueueFactCategory,
    readonly conflicts: FactIdentityConflict[],
  ) {
    super(`Agent ${category} contains conflicting values for one identity`);
    this.name = 'AgentFactIdentityConflictError';
  }

  get vendorSessionIds(): string[] {
    const ids = this.conflicts.map((conflict) => conflict.vendorSessionId).filter(Boolean);
    return [...new Set(ids)].sort();
  }
}

/**
 * One delivery revision cannot safely contain two values for the same natural identity. Rows that
 * differ only by a position excluded from their identity collapse to the lowest position: Claude
 * Code re-appends the conversation tail after `compact_boundary` with the original ids.
 */
export function normalizeAgentFactIdentities(facts: AgentIngestQueueFacts): AgentIngestQueueFacts {
  const normalized: Partial<Record<QueueFactCategory, unknown[]>> = {};
  for (const [category, rule] of Object.entries(IDENTITY_RULES) as [
    QueueFactCategory,
    IdentityRule,
  ][]) {
    const { accepted, conflicts } = collapseFacts(facts[category] as unknown[], rule);
    if (conflicts.length > 0) throw new AgentFactIdentityConflictError(category, conflicts);
    normalized[category] = accepted;
  }
  return normalized as unknown as AgentIngestQueueFacts;
}

function collapseFacts(
  rows: unknown[],
  rule: IdentityRule,
): { accepted: unknown[]; conflicts: FactIdentityConflict[] } {
  const accepted: unknown[] = [];
  const slotByIdentity = new Map<string, number>();
  const conflicts: FactIdentityConflict[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      accepted.push(row);
      continue;
    }
    const value = row as Record<string, unknown>;
    const identityPk = value[rule.identity];
    if (typeof value.session_pk !== 'string' || typeof identityPk !== 'string') {
      accepted.push(row);
      continue;
    }
    const identity = JSON.stringify([value.session_pk, identityPk]);
    const slot = slotByIdentity.get(identity);
    if (slot === undefined) {
      slotByIdentity.set(identity, accepted.length);
      accepted.push(row);
      continue;
    }
    const previous = accepted[slot] as Record<string, unknown>;
    if (comparable(previous, rule) !== comparable(value, rule)) {
      const vendorSessionId =
        typeof value.vendor_session_id === 'string' ? value.vendor_session_id : '';
      conflicts.push({ vendorSessionId, identityPk });
    } else if (positionOf(value, rule) < positionOf(previous, rule)) {
      accepted[slot] = row;
    }
  }
  return { accepted, conflicts };
}

function excludesPosition(row: Record<string, unknown>, rule: IdentityRule): boolean {
  // Mirrors the `??` fallback in `ids.ts`: any non-null source id, even '', owns the identity.
  return rule.position !== undefined && row[rule.position.sourceId] != null;
}

function comparable(row: Record<string, unknown>, rule: IdentityRule): string {
  if (!excludesPosition(row, rule)) return canonicalJson(row);
  const { [rule.position!.field]: _position, ...rest } = row;
  return canonicalJson(rest);
}

function positionOf(row: Record<string, unknown>, rule: IdentityRule): number {
  const position = rule.position ? row[rule.position.field] : undefined;
  return typeof position === 'number' ? position : Number.POSITIVE_INFINITY;
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
