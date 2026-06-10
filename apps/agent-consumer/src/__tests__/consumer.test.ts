import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Sentry from '@sentry/cloudflare';
import { microdollarsToDollars, type ModelPricing } from '@trace-flow/pricing';
import type { AgentSource } from '@trace-flow/types';
import { processAgentBatch } from '../consumer';

// withSentry initializes the client in the deployed Worker; here we mock the capture surface so the
// error paths (insert failure, contract drift) can assert they report rather than fail silently.
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
import {
  batchOf,
  makeEnv,
  makeKv,
  mockTinybird,
  stubMessage,
  type CapturedInsert,
} from './harness';
import {
  capabilitySnapshotFact,
  emptyQueueFacts,
  fileEventFact,
  messageFact,
  pullRequestLinkFact,
  queueMessage,
  toolEventFact,
} from './factories';

const PRICING: ModelPricing = {
  promptCostPerMillion: 3,
  completionCostPerMillion: 15,
  updatedAt: 0,
  source: 'manual',
};
const PRICING_KEY = 'pricing:anthropic:claude-opus-4-7';

// 1_000_000 uncached input tokens × $3/M = 3 microdollars = $0.000003 per message.
const PER_MESSAGE_USD = microdollarsToDollars(3);

function insertFor(inserts: CapturedInsert[], datasource: string): CapturedInsert | undefined {
  return inserts.find((i) => i.datasource === datasource);
}

let tb: ReturnType<typeof mockTinybird>;

afterEach(() => {
  tb?.restore();
  vi.clearAllMocks();
});

describe('processAgentBatch', () => {
  it('prices a message and inserts it into agent_message_facts, then acks', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const msg = stubMessage(
      queueMessage({
        facts: { ...emptyQueueFacts(), messages: [messageFact({ input_tokens: 1_000_000 })] },
      }),
    );

    await processAgentBatch(batchOf([msg]), makeEnv(kv));

    const insert = insertFor(tb.inserts, 'agent_message_facts');
    expect(insert?.rows).toHaveLength(1);
    expect(insert?.rows[0]?.cost_usd).toBe(PER_MESSAGE_USD);
    expect(insert?.rows[0]?.OrgId).toBe('org-1');
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('sums a constant-cost fixture to the exact expected total', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const N = 4;
    const messages = Array.from({ length: N }, (_, i) =>
      messageFact({ message_pk: `msg_${i}`, input_tokens: 1_000_000 }),
    );
    const msg = stubMessage(queueMessage({ facts: { ...emptyQueueFacts(), messages } }));

    await processAgentBatch(batchOf([msg]), makeEnv(kv));

    const rows = insertFor(tb.inserts, 'agent_message_facts')!.rows;
    expect(rows).toHaveLength(N);
    for (const row of rows) {
      expect(row.cost_usd).toBe(PER_MESSAGE_USD);
    }
    const total = rows.reduce((sum, row) => sum + (row.cost_usd as number), 0);
    expect(total).toBeCloseTo(PER_MESSAGE_USD * N, 12);
  });

  it('writes null cost_usd for an unpriced model', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({}); // empty catalog
    const msg = stubMessage(
      queueMessage({
        facts: {
          ...emptyQueueFacts(),
          messages: [messageFact({ model: 'mystery-model', input_tokens: 1_000_000 })],
        },
      }),
    );

    await processAgentBatch(batchOf([msg]), makeEnv(kv));

    expect(insertFor(tb.inserts, 'agent_message_facts')!.rows[0]?.cost_usd).toBeNull();
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('writes null cost_usd when token coverage is missing, even with a priced model', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const msg = stubMessage(
      queueMessage({
        facts: {
          ...emptyQueueFacts(),
          messages: [messageFact({ token_coverage: 'missing', input_tokens: 1_000_000 })],
        },
      }),
    );

    await processAgentBatch(batchOf([msg]), makeEnv(kv));

    expect(insertFor(tb.inserts, 'agent_message_facts')!.rows[0]?.cost_usd).toBeNull();
  });

  it('reads the price catalog once per distinct (provider, model), not per message', async () => {
    tb = mockTinybird();
    const { kv, get } = makeKv({ [PRICING_KEY]: PRICING });
    const messages = Array.from({ length: 50 }, (_, i) =>
      messageFact({ message_pk: `msg_${i}`, input_tokens: 1_000_000 }),
    );
    const msg = stubMessage(queueMessage({ facts: { ...emptyQueueFacts(), messages } }));

    await processAgentBatch(batchOf([msg]), makeEnv(kv));

    expect(get).toHaveBeenCalledTimes(1); // 50 messages, one model
  });

  it('makes one KV read per distinct model across the batch', async () => {
    tb = mockTinybird();
    const { kv, get } = makeKv({ [PRICING_KEY]: PRICING });
    const messages = [
      messageFact({ message_pk: 'a', model: 'claude-opus-4-7' }),
      messageFact({ message_pk: 'b', model: 'claude-haiku-4-5' }),
      messageFact({ message_pk: 'c', model: 'claude-opus-4-7' }),
    ];
    const msg = stubMessage(queueMessage({ facts: { ...emptyQueueFacts(), messages } }));

    await processAgentBatch(batchOf([msg]), makeEnv(kv));

    expect(get).toHaveBeenCalledTimes(2); // opus + haiku, opus cached on reuse
  });

  it('retries a malformed message (DLQ path) without acking or inserting', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const bad = stubMessage({ type: 'not-agent' });

    await processAgentBatch(batchOf([bad]), makeEnv(kv));

    expect(bad.retry).toHaveBeenCalledOnce();
    expect(bad.ack).not.toHaveBeenCalled();
    expect(tb.inserts).toHaveLength(0);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'agent_consumer.message_malformed',
      expect.objectContaining({ level: 'error', extra: { messageId: 'm1' } }),
    );
  });

  it('retries a message with an empty scalar source (contract drift, not just bad container)', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const bad = stubMessage(queueMessage({ source: '' as unknown as AgentSource }));

    await processAgentBatch(batchOf([bad]), makeEnv(kv));

    expect(bad.retry).toHaveBeenCalledOnce();
    expect(bad.ack).not.toHaveBeenCalled();
    expect(tb.inserts).toHaveLength(0);
  });

  it('retries a message whose tenancy ids are not strings (guards the fields rows.ts dereferences)', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const bad = stubMessage(
      queueMessage({
        tenancy: {
          org_id: 'org-1',
          user_id: 'user-1',
          collector_id: 'collector-1',
          collector_credential_id: 123 as unknown as string,
        },
      }),
    );

    await processAgentBatch(batchOf([bad]), makeEnv(kv));

    expect(bad.retry).toHaveBeenCalledOnce();
    expect(bad.ack).not.toHaveBeenCalled();
    expect(tb.inserts).toHaveLength(0);
  });

  it('isolates a malformed message and still processes its well-formed siblings', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const bad = stubMessage({ facts: {} }, 'bad');
    const good = stubMessage(queueMessage(), 'good');

    await processAgentBatch(batchOf([bad, good]), makeEnv(kv));

    expect(bad.retry).toHaveBeenCalledOnce();
    expect(good.ack).toHaveBeenCalledOnce();
    expect(insertFor(tb.inserts, 'agent_message_facts')!.rows).toHaveLength(1);
  });

  it('retries every contributing message when an insert fails (no ack, no silent drop)', async () => {
    tb = mockTinybird(['agent_message_facts']);
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const a = stubMessage(queueMessage(), 'a');
    const b = stubMessage(queueMessage(), 'b');

    await processAgentBatch(batchOf([a, b]), makeEnv(kv));

    expect(a.retry).toHaveBeenCalledOnce();
    expect(b.retry).toHaveBeenCalledOnce();
    expect(a.ack).not.toHaveBeenCalled();
    expect(b.ack).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ operation: 'agent_fact_batcher' }),
      }),
    );
  });

  it('issues one insert per non-empty base datasource', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const msg = stubMessage(
      queueMessage({
        facts: {
          messages: [messageFact()],
          tool_events: [toolEventFact()],
          file_events: [fileEventFact()],
          capability_snapshots: [capabilitySnapshotFact()],
          pull_request_links: [pullRequestLinkFact()],
        },
      }),
    );

    await processAgentBatch(batchOf([msg]), makeEnv(kv));

    expect(tb.inserts.map((i) => i.datasource).sort()).toEqual([
      'agent_capability_snapshot_facts',
      'agent_file_event_facts',
      'agent_message_facts',
      'agent_pull_request_facts',
      'agent_tool_event_facts',
    ]);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('dual-writes clean and legacy agent tables during phased rollout', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const msg = stubMessage(
      queueMessage({
        facts: {
          ...emptyQueueFacts(),
          messages: [messageFact({ input_tokens: 1_000_000 })],
        },
      }),
    );

    await processAgentBatch(batchOf([msg]), makeEnv(kv, { TINYBIRD_AGENT_WRITE_MODE: 'dual' }));

    expect(tb.inserts.map((i) => i.datasource).sort()).toEqual([
      'agent_message_facts',
      'agent_messages',
    ]);
    expect(insertFor(tb.inserts, 'agent_message_facts')?.rows[0]?.cost_usd).toBe(PER_MESSAGE_USD);
    expect(insertFor(tb.inserts, 'agent_messages')?.rows[0]?.cost_usd).toBe(PER_MESSAGE_USD);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('can write legacy-only for rollback while clean tables remain untouched', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const msg = stubMessage(queueMessage());

    await processAgentBatch(batchOf([msg]), makeEnv(kv, { TINYBIRD_AGENT_WRITE_MODE: 'legacy' }));

    expect(tb.inserts.map((i) => i.datasource)).toEqual(['agent_messages']);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('dedupes repeated rows inside one queue batch before inserting', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const first = stubMessage(
      queueMessage({
        collector_batch_id: 'batch-a',
        facts: { ...emptyQueueFacts(), messages: [messageFact({ input_tokens: 1 })] },
      }),
      'a',
    );
    const second = stubMessage(
      queueMessage({
        collector_batch_id: 'batch-b',
        facts: { ...emptyQueueFacts(), messages: [messageFact({ input_tokens: 2 })] },
      }),
      'b',
    );

    await processAgentBatch(batchOf([first, second]), makeEnv(kv));

    const rows = insertFor(tb.inserts, 'agent_message_facts')!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input_tokens).toBe(2);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
  });

  it('acks an empty-facts message without inserting', async () => {
    tb = mockTinybird();
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const msg = stubMessage(queueMessage({ facts: emptyQueueFacts() }));

    await processAgentBatch(batchOf([msg]), makeEnv(kv));

    expect(tb.inserts).toHaveLength(0);
    expect(msg.ack).toHaveBeenCalledOnce();
  });
});
