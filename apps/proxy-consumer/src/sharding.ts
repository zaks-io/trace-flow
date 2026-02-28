import { hashString } from '@trace-flow/utils';

/**
 * Calculates the shard ID for a given API key using consistent hashing.
 *
 * Shards distribute load across multiple Durable Object instances, with each API key
 * always routing to the same shard. This ensures ordering guarantees within a shard
 * while allowing parallel processing across shards.
 *
 * The modulo operation distributes keys evenly across NUM_SHARDS.
 */
export function calculateShardId(apiKey: string, numShards: number): number {
  return hashString(apiKey) % numShards;
}
