import { vi } from 'vitest';
import type { ModelPricing } from '@trace-flow/pricing';

export function makeKv(entries: Record<string, ModelPricing>): {
  kv: KVNamespace;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (key: string) => entries[key] ?? null);
  return { kv: { get } as unknown as KVNamespace, get };
}
