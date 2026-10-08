import {
  AGENT_INGEST_LIMITS,
  validateAgentIngestQueueMessage,
  type AgentIngestQueueFacts,
  type AgentIngestQueueMessage,
} from '@trace-flow/types';

/**
 * Keep the established chunk ceiling because chunk boundaries determine durable retry identities.
 * Delivery references go through the Queue; these fact chunks are encrypted and stored in R2.
 */
export const MAX_QUEUE_MESSAGE_BYTES = 124_000;

type QueueFactCategory = keyof AgentIngestQueueFacts;

/**
 * The fact arrays the chunker walks. Exported so a test can assert it stays in lockstep with
 * {@link AgentIngestQueueFacts}. A category missing here would silently drop that fact array.
 */
export const CATEGORIES: QueueFactCategory[] = [
  'messages',
  'tool_events',
  'file_events',
  'capability_snapshots',
  'pull_request_links',
  'review_unit_attributions',
];

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

export class QueueFactTooLargeError extends Error {
  constructor(
    readonly category: QueueFactCategory,
    readonly factBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `A ${category} fact requires ${factBytes} bytes in its queue message; limit is ${maxBytes}`,
    );
    this.name = 'QueueFactTooLargeError';
  }
}

export class QueueMessageContractError extends Error {
  constructor(readonly field: string) {
    super(`Generated queue message violates the queue contract at ${field}`);
    this.name = 'QueueMessageContractError';
  }
}

export function assertQueueMessagesValid(messages: readonly AgentIngestQueueMessage[]): void {
  for (const message of messages) {
    const field = validateAgentIngestQueueMessage(message);
    if (field) throw new QueueMessageContractError(field);
  }
}

function emptyFacts(): AgentIngestQueueFacts {
  return {
    messages: [],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
    review_unit_attributions: [],
  };
}

function assertFactsFitQueueMessages(
  base: Omit<AgentIngestQueueMessage, 'facts'>,
  facts: AgentIngestQueueFacts,
  maxBytes: number = MAX_QUEUE_MESSAGE_BYTES,
  stableAttempts = false,
): void {
  const baseSize = chunkBaseSize(base, stableAttempts);
  for (const category of CATEGORIES) {
    for (const fact of facts[category] ?? []) {
      const messageBytes = baseSize + byteLength(fact);
      if (messageBytes > maxBytes) {
        throw new QueueFactTooLargeError(category, messageBytes, maxBytes);
      }
    }
  }
}

/**
 * Greedily packs the fact arrays into one or more delivery chunks, each under
 * {@link MAX_QUEUE_MESSAGE_BYTES}. Facts are independent at rest (the consumer dedups on the
 * deterministic `*_pk`s), so a session may straddle messages without affecting correctness. A
 * single oversized fact is rejected to preserve the established chunk-size contract.
 */
export function chunkFacts(
  base: Omit<AgentIngestQueueMessage, 'facts'>,
  facts: AgentIngestQueueFacts,
  maxBytes: number = MAX_QUEUE_MESSAGE_BYTES,
  stableAttempts = false,
): AgentIngestQueueMessage[] {
  const baseSize = chunkBaseSize(base, stableAttempts);
  assertFactsFitQueueMessages(base, facts, maxBytes, stableAttempts);
  const messages: AgentIngestQueueMessage[] = [];

  let current = emptyFacts();
  let currentSize = baseSize;
  let currentCount = 0;

  const flush = (): void => {
    if (currentCount === 0) return;
    messages.push({ ...base, facts: current });
    current = emptyFacts();
    currentSize = baseSize;
    currentCount = 0;
  };

  for (const category of CATEGORIES) {
    for (const fact of facts[category] ?? []) {
      const factBytes = byteLength(fact);
      let factSize = factBytes + ((current[category]?.length ?? 0) > 0 ? 1 : 0);
      if (currentCount > 0 && currentSize + factSize > maxBytes) flush();
      factSize = factBytes + ((current[category]?.length ?? 0) > 0 ? 1 : 0);
      (current[category] as unknown[]).push(fact);
      currentSize += factSize;
      currentCount += 1;
    }
  }

  flush();
  return messages;
}

function chunkBaseSize(
  base: Omit<AgentIngestQueueMessage, 'facts'>,
  stableAttempts: boolean,
): number {
  if (!stableAttempts) return byteLength({ ...base, facts: emptyFacts() });
  const { enqueued_at: _enqueuedAt, sentry_trace_context: _trace, ...content } = base;
  // Sentry emits ASCII trace headers and URI-encoded baggage. Bound their serialized form too,
  // so escaping cannot overflow the reserved space or move retry chunk boundaries.
  const size =
    byteLength({
      ...content,
      enqueued_at: Number.MAX_SAFE_INTEGER,
      sentry_trace_context: {
        'sentry-trace': '',
        baggage: '',
      },
      facts: emptyFacts(),
    }) +
    2 * AGENT_INGEST_LIMITS.maxTraceHeaderBytes;
  if (byteLength({ ...base, facts: emptyFacts() }) > size) {
    throw new QueueMessageContractError('sentry_trace_context');
  }
  return size;
}
