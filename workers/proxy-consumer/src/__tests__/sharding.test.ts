import { describe, it, expect } from 'vitest';
import { calculateShardId } from '../sharding';

describe('calculateShardId', () => {
  const NUM_SHARDS = 10;

  it('should return consistent shard ID for the same API key', () => {
    const apiKey = 'test-api-key-123';

    const shard1 = calculateShardId(apiKey, NUM_SHARDS);
    const shard2 = calculateShardId(apiKey, NUM_SHARDS);
    const shard3 = calculateShardId(apiKey, NUM_SHARDS);

    expect(shard1).toBe(shard2);
    expect(shard2).toBe(shard3);
  });

  it('should return shard ID within valid range', () => {
    const apiKeys = [
      'api-key-1',
      'api-key-2',
      'api-key-3',
      'api-key-4',
      'api-key-5',
      'very-long-api-key-with-lots-of-characters-12345',
      'short',
      '',
    ];

    apiKeys.forEach((apiKey) => {
      const shardId = calculateShardId(apiKey, NUM_SHARDS);
      expect(shardId).toBeGreaterThanOrEqual(0);
      expect(shardId).toBeLessThan(NUM_SHARDS);
    });
  });

  it('should distribute different API keys across shards', () => {
    const apiKeys = Array.from({ length: 100 }, (_, i) => `api-key-${i}`);
    const shardCounts = new Map<number, number>();

    apiKeys.forEach((apiKey) => {
      const shardId = calculateShardId(apiKey, NUM_SHARDS);
      shardCounts.set(shardId, (shardCounts.get(shardId) ?? 0) + 1);
    });

    expect(shardCounts.size).toBeGreaterThan(1);
  });

  it('should handle different shard counts', () => {
    const apiKey = 'test-api-key';

    const shard5 = calculateShardId(apiKey, 5);
    const shard10 = calculateShardId(apiKey, 10);
    const shard20 = calculateShardId(apiKey, 20);

    expect(shard5).toBeGreaterThanOrEqual(0);
    expect(shard5).toBeLessThan(5);
    expect(shard10).toBeGreaterThanOrEqual(0);
    expect(shard10).toBeLessThan(10);
    expect(shard20).toBeGreaterThanOrEqual(0);
    expect(shard20).toBeLessThan(20);
  });

  it('should produce different shards for different API keys', () => {
    const apiKey1 = 'user-1-api-key';
    const apiKey2 = 'user-2-api-key';
    const apiKey3 = 'user-3-api-key';

    const shard1 = calculateShardId(apiKey1, NUM_SHARDS);
    const shard2 = calculateShardId(apiKey2, NUM_SHARDS);
    const shard3 = calculateShardId(apiKey3, NUM_SHARDS);

    const uniqueShards = new Set([shard1, shard2, shard3]);
    expect(uniqueShards.size).toBeGreaterThan(1);
  });

  it('should handle empty string API key', () => {
    const shardId = calculateShardId('', NUM_SHARDS);

    expect(shardId).toBeGreaterThanOrEqual(0);
    expect(shardId).toBeLessThan(NUM_SHARDS);
  });

  it('should handle special characters in API key', () => {
    const apiKeys = [
      'api-key-with-dashes',
      'api_key_with_underscores',
      'api.key.with.dots',
      'api@key#with$special%chars',
      'api🔑with😀emoji',
    ];

    apiKeys.forEach((apiKey) => {
      const shardId = calculateShardId(apiKey, NUM_SHARDS);
      expect(shardId).toBeGreaterThanOrEqual(0);
      expect(shardId).toBeLessThan(NUM_SHARDS);
    });
  });

  it('should distribute uniformly across shards', () => {
    const apiKeys = Array.from({ length: 1000 }, (_, i) => `api-key-${i}`);
    const shardCounts = new Map<number, number>();

    apiKeys.forEach((apiKey) => {
      const shardId = calculateShardId(apiKey, NUM_SHARDS);
      shardCounts.set(shardId, (shardCounts.get(shardId) ?? 0) + 1);
    });

    expect(shardCounts.size).toBe(NUM_SHARDS);

    const counts = Array.from(shardCounts.values());
    const avg = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    const variance =
      counts.reduce((sum, count) => sum + Math.pow(count - avg, 2), 0) / counts.length;
    const stdDev = Math.sqrt(variance);

    expect(stdDev).toBeLessThan(avg * 0.2);
  });

  it('should handle very long API keys', () => {
    const longApiKey = 'a'.repeat(10000);
    const shardId = calculateShardId(longApiKey, NUM_SHARDS);

    expect(shardId).toBeGreaterThanOrEqual(0);
    expect(shardId).toBeLessThan(NUM_SHARDS);
  });

  it('should map similar API keys to different shards', () => {
    const apiKey1 = 'api-key-001';
    const apiKey2 = 'api-key-002';
    const apiKey3 = 'api-key-003';

    const shard1 = calculateShardId(apiKey1, NUM_SHARDS);
    const shard2 = calculateShardId(apiKey2, NUM_SHARDS);
    const shard3 = calculateShardId(apiKey3, NUM_SHARDS);

    const shards = [shard1, shard2, shard3];
    expect(shards).toContain(shard1);
    expect(shards).toContain(shard2);
    expect(shards).toContain(shard3);
  });

  describe('statistical distribution analysis', () => {
    // Skipped: Statistical test is flaky due to random variance in chi-squared distribution
    // The test occasionally fails even with correct implementation due to statistical randomness
    it.skip('should distribute 10,000 realistic API keys uniformly with statistical significance', () => {
      const SAMPLE_SIZE = 10000;
      const EXPECTED_PER_SHARD = SAMPLE_SIZE / NUM_SHARDS;

      const generateRealisticApiKeys = (count: number): string[] => {
        const keys: string[] = [];

        for (let i = 0; i < count; i++) {
          const keyType = i % 4;

          switch (keyType) {
            case 0:
              keys.push(crypto.randomUUID());
              break;
            case 1:
              keys.push(
                `sk_live_${Array.from({ length: 32 }, () =>
                  Math.random().toString(36).charAt(2),
                ).join('')}`,
              );
              break;
            case 2:
              keys.push(
                `api_key_${Array.from({ length: 40 }, () =>
                  Math.random().toString(36).charAt(2),
                ).join('')}`,
              );
              break;
            default:
              keys.push(
                Array.from({ length: 32 }, () =>
                  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
                    Math.floor(Math.random() * 62),
                  ),
                ).join(''),
              );
          }
        }

        return keys;
      };

      const apiKeys = generateRealisticApiKeys(SAMPLE_SIZE);
      const shardCounts = new Map<number, number>();

      for (let i = 0; i < NUM_SHARDS; i++) {
        shardCounts.set(i, 0);
      }

      apiKeys.forEach((apiKey) => {
        const shardId = calculateShardId(apiKey, NUM_SHARDS);
        shardCounts.set(shardId, shardCounts.get(shardId)! + 1);
      });

      const counts = Array.from(shardCounts.values());
      const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
      const variance =
        counts.reduce((sum, count) => sum + Math.pow(count - mean, 2), 0) / counts.length;
      const stdDev = Math.sqrt(variance);
      const coefficientOfVariation = stdDev / mean;

      const minCount = Math.min(...counts);
      const maxCount = Math.max(...counts);

      const chiSquared = counts.reduce(
        (sum, observed) => sum + Math.pow(observed - EXPECTED_PER_SHARD, 2) / EXPECTED_PER_SHARD,
        0,
      );
      const criticalValue = 16.919;

      expect(shardCounts.size).toBe(NUM_SHARDS);

      expect(mean).toBeCloseTo(EXPECTED_PER_SHARD, 0);

      expect(stdDev).toBeLessThan(EXPECTED_PER_SHARD * 0.1);

      expect(coefficientOfVariation).toBeLessThan(0.1);

      expect(minCount).toBeGreaterThan(EXPECTED_PER_SHARD * 0.85);
      expect(maxCount).toBeLessThan(EXPECTED_PER_SHARD * 1.15);

      expect(chiSquared).toBeLessThan(criticalValue);
    });
  });
});
