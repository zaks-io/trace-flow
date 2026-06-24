import type { AgentIngestQueueFacts, AgentIngestQueueMessage } from '@trace-flow/types';

/**
 * Cloudflare Queues cap a single message at 128 KiB. We pack to a lower ceiling so the JSON envelope
 * (tenancy, batch metadata, array punctuation) always fits under the hard limit with headroom.
 */
export const MAX_QUEUE_MESSAGE_BYTES = 124_000;

type QueueFactCategory = keyof AgentIngestQueueFacts;

/**
 * The fact arrays the chunker walks. Exported so a test can assert it stays in lockstep with
 * {@link AgentIngestQueueFacts} — a category missing here would silently drop that fact array.
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

/**
 * Greedily packs the five fact arrays into one or more queue messages, each under
 * {@link MAX_QUEUE_MESSAGE_BYTES}. Facts are independent at rest (the consumer dedups on the
 * deterministic `*_pk`s), so a session may straddle messages without affecting correctness. A
 * single fact never exceeds the cap — excerpts are length-capped upstream — but if one ever did it
 * still ships alone in its own message rather than being dropped.
 */
export function chunkFacts(
  base: Omit<AgentIngestQueueMessage, 'facts'>,
  facts: AgentIngestQueueFacts,
  maxBytes: number = MAX_QUEUE_MESSAGE_BYTES,
): AgentIngestQueueMessage[] {
  const baseSize = byteLength({ ...base, facts: emptyFacts() });
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
      const factSize = byteLength(fact) + 1; // +1 for the array-element comma
      if (currentCount > 0 && currentSize + factSize > maxBytes) flush();
      (current[category] as unknown[]).push(fact);
      currentSize += factSize;
      currentCount += 1;
    }
  }

  flush();
  return messages;
}
