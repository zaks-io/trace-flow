import { describe, expect, it } from 'vitest';
import { microdollarsToDollars, type ModelPricing } from '@trace-flow/pricing';
import { accumulateMessage } from '../consumer';
import { emptyAccumulator } from '../facts';
import { PriceCache } from '../pricing';
import { emptyQueueFacts, messageFact, queueMessage } from './factories';
import { makeKv } from './harness';

const PRICING: ModelPricing = {
  promptCostPerMillion: 3,
  completionCostPerMillion: 15,
  updatedAt: 0,
  source: 'manual',
};
const PRICING_KEY = 'pricing:anthropic:claude-opus-4-7';
const PER_MESSAGE_USD = microdollarsToDollars(3);

describe('accumulateMessage', () => {
  it('prices a message and retains its organization in the accumulated row', async () => {
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const rows = emptyAccumulator();
    await accumulateMessage(
      queueMessage({
        facts: { ...emptyQueueFacts(), messages: [messageFact({ input_tokens: 1_000_000 })] },
      }),
      rows,
      new PriceCache(kv),
    );
    expect(rows.messages).toEqual([
      expect.objectContaining({ cost_usd: PER_MESSAGE_USD, OrgId: 'org-1' }),
    ]);
  });

  it('accepts facts without the optional review attribution array', async () => {
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const body = queueMessage();
    delete (body.facts as Partial<typeof body.facts>).review_unit_attributions;
    const rows = emptyAccumulator();
    await accumulateMessage(body, rows, new PriceCache(kv));
    expect(rows.messages).toHaveLength(1);
    expect(rows.review_unit_attributions).toEqual([]);
  });

  it('sums a constant-cost fixture to the expected total', async () => {
    const { kv } = makeKv({ [PRICING_KEY]: PRICING });
    const messages = Array.from({ length: 4 }, (_, i) =>
      messageFact({ message_pk: `msg_${i}`, input_tokens: 1_000_000 }),
    );
    const rows = emptyAccumulator();
    await accumulateMessage(
      queueMessage({ facts: { ...emptyQueueFacts(), messages } }),
      rows,
      new PriceCache(kv),
    );
    const costs = rows.messages.map((row) => (row as { cost_usd: number }).cost_usd);
    expect(costs).toEqual(Array(4).fill(PER_MESSAGE_USD));
    expect(costs.reduce((total, cost) => total + cost, 0)).toBeCloseTo(PER_MESSAGE_USD * 4, 12);
  });

  it('preserves null cost for an unpriced model', async () => {
    const { kv } = makeKv({});
    const rows = emptyAccumulator();
    await accumulateMessage(
      queueMessage({
        facts: {
          ...emptyQueueFacts(),
          messages: [messageFact({ model: 'mystery-model', input_tokens: 1_000_000 })],
        },
      }),
      rows,
      new PriceCache(kv),
    );
    expect(rows.messages).toEqual([expect.objectContaining({ cost_usd: null })]);
  });

  it('preserves null cost when token coverage is missing', async () => {
    const { kv, get } = makeKv({ [PRICING_KEY]: PRICING });
    const rows = emptyAccumulator();
    await accumulateMessage(
      queueMessage({
        facts: {
          ...emptyQueueFacts(),
          messages: [messageFact({ token_coverage: 'missing', input_tokens: 1_000_000 })],
        },
      }),
      rows,
      new PriceCache(kv),
    );
    expect(rows.messages).toEqual([expect.objectContaining({ cost_usd: null })]);
    expect(get).not.toHaveBeenCalled();
  });

  it('reads pricing once for repeated messages with the same model', async () => {
    const { kv, get } = makeKv({ [PRICING_KEY]: PRICING });
    const messages = Array.from({ length: 50 }, (_, i) =>
      messageFact({ message_pk: `msg_${i}`, input_tokens: 1_000_000 }),
    );
    const rows = emptyAccumulator();
    await accumulateMessage(
      queueMessage({ facts: { ...emptyQueueFacts(), messages } }),
      rows,
      new PriceCache(kv),
    );
    expect(rows.messages).toHaveLength(50);
    expect(get).toHaveBeenCalledExactlyOnceWith(PRICING_KEY, 'json');
  });

  it('shares pricing reads across deliveries and caches missing model rates', async () => {
    const { kv, get } = makeKv({ [PRICING_KEY]: PRICING });
    const cache = new PriceCache(kv);
    const rows = emptyAccumulator();
    for (const model of [
      'claude-opus-4-7',
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-haiku-4-5',
    ]) {
      await accumulateMessage(
        queueMessage({ facts: { ...emptyQueueFacts(), messages: [messageFact({ model })] } }),
        rows,
        cache,
      );
    }
    expect(get).toHaveBeenCalledTimes(2);
    expect(rows.messages).toHaveLength(4);
  });

  it('leaves every accumulator empty when the delivery contains no facts', async () => {
    const { kv, get } = makeKv({ [PRICING_KEY]: PRICING });
    const rows = emptyAccumulator();
    await accumulateMessage(queueMessage({ facts: emptyQueueFacts() }), rows, new PriceCache(kv));
    expect(rows).toEqual(emptyAccumulator());
    expect(get).not.toHaveBeenCalled();
  });
});
