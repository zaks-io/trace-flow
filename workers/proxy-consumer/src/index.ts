import type { QueueMessage, TinybirdTrace } from '@observe/types';
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
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    const NUM_SHARDS = env.NUM_SHARDS ?? 10;
    const startTime = Date.now();
    console.log(`Processing queue batch: ${batch.messages.length} messages`);

    const shardedMessages = new Map<
      number,
      {
        traces: TinybirdTrace[];
        messages: Message<QueueMessage>[];
      }
    >();

    const failedMessages: Message<QueueMessage>[] = [];

    for (const message of batch.messages) {
      try {
        const traces = buildTraces(message.body);
        const shardId = calculateShardId(message.body.apiKey, NUM_SHARDS);

        if (!shardedMessages.has(shardId)) {
          shardedMessages.set(shardId, { traces: [], messages: [] });
        }

        const shard = shardedMessages.get(shardId)!;
        shard.traces.push(...traces);
        shard.messages.push(message);
      } catch (error) {
        console.error('Failed to build traces for message:', {
          requestId: message.body.requestId,
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
