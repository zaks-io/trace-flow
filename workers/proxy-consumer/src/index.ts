import type { QueueMessageUnion, TinybirdTrace, QueueMessage } from '@trace-flow/types';
import { TraceBatcher } from './batcher';
import { buildTraces } from './traces';
import { calculateShardId } from './sharding';
import { getPricing, type ModelPricing } from './pricing';
import { fetchOpenRouterPricing } from './openrouter-pricing';

export { TraceBatcher };

export interface Env {
  STORAGE: R2Bucket;
  TINYBIRD_TOKEN: string;
  TINYBIRD_DATASOURCE?: string;
  TINYBIRD_HOST?: string;
  TRACE_BATCHER: DurableObjectNamespace<TraceBatcher>;
  NUM_SHARDS?: number;
  MODEL_PRICING: KVNamespace;
}

async function getPricingForMessage(
  data: QueueMessage,
  kv: KVNamespace,
): Promise<ModelPricing | null> {
  const provider = data.request.provider;
  const model = data.responseMetadata?.model ?? data.request.model;

  // Try KV first
  let pricing = await getPricing(kv, provider, model);
  if (pricing) return pricing;

  // For OpenRouter, auto-fetch pricing if not in KV
  if (provider === 'openrouter') {
    pricing = await fetchOpenRouterPricing(model, kv);
    if (pricing) return pricing;
  }

  // For other providers, skip cost if not in KV
  return null;
}

export default {
  async queue(batch: MessageBatch<QueueMessageUnion>, env: Env): Promise<void> {
    const NUM_SHARDS = env.NUM_SHARDS ?? 10;

    const shardedMessages = new Map<
      number,
      {
        traces: TinybirdTrace[];
        messages: Message<QueueMessageUnion>[];
      }
    >();

    const failedMessages: Message<QueueMessageUnion>[] = [];

    for (const message of batch.messages) {
      try {
        let traces: TinybirdTrace[];
        let apiKey: string;

        if (message.body.type === 'otlp') {
          traces = message.body.traces;
          apiKey = message.body.apiKey;
        } else {
          const pricing = await getPricingForMessage(message.body, env.MODEL_PRICING);
          traces = buildTraces(message.body, pricing);
          apiKey = message.body.apiKey;
        }

        const shardId = calculateShardId(apiKey, NUM_SHARDS);

        if (!shardedMessages.has(shardId)) {
          shardedMessages.set(shardId, { traces: [], messages: [] });
        }

        const shard = shardedMessages.get(shardId)!;
        shard.traces.push(...traces);
        shard.messages.push(message);
      } catch (error) {
        const messageId =
          message.body.type === 'otlp' ? `otlp:${message.body.receivedAt}` : message.body.requestId;
        console.error('Failed to process message:', {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        failedMessages.push(message);
      }
    }

    const shardPromises = Array.from(shardedMessages.entries()).map(async ([shardId, shard]) => {
      try {
        const batcherId = env.TRACE_BATCHER.idFromName(`batcher-${shardId}`);
        const batcher = env.TRACE_BATCHER.get(batcherId);

        await batcher.addTraces(shard.traces);

        for (const message of shard.messages) {
          message.ack();
        }
      } catch (error) {
        console.error(`Shard ${shardId}: Failed to add traces to batcher:`, {
          error: error instanceof Error ? error.message : String(error),
        });

        for (const message of shard.messages) {
          message.retry();
        }
      }
    });

    await Promise.all(shardPromises);

    for (const message of failedMessages) {
      message.retry();
    }
  },
};
