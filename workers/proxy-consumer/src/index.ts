import type { QueueMessageUnion, TinybirdTrace } from '@observe/types';
import { TraceBatcher } from './batcher';
import { buildTraces } from './traces';
import { calculateShardId } from './sharding';

export { TraceBatcher };

export interface Env {
  STORAGE: R2Bucket;
  TINYBIRD_TOKEN: string;
  TINYBIRD_DATASOURCE?: string;
  TINYBIRD_HOST?: string;
  TRACE_BATCHER: DurableObjectNamespace<TraceBatcher>;
  NUM_SHARDS?: number;
}

export default {
  async queue(batch: MessageBatch<QueueMessageUnion>, env: Env): Promise<void> {
    const NUM_SHARDS = env.NUM_SHARDS ?? 10;
    const startTime = Date.now();
    console.log(`Processing queue batch: ${batch.messages.length} messages`);

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
          // OTLP messages contain pre-transformed traces
          traces = message.body.traces;
          apiKey = message.body.apiKey;
        } else {
          // LLM messages need transformation (type is 'llm' or undefined for backward compatibility)
          traces = buildTraces(message.body);
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
          type: message.body.type ?? 'llm',
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

        console.log(
          `Shard ${shardId}: Successfully processed ${shard.messages.length} messages (${shard.traces.length} traces)`,
        );
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

    console.log(
      `Processed ${batch.messages.length} messages across ${shardedMessages.size} shards in ${Date.now() - startTime}ms`,
    );
  },
};
