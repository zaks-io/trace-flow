import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  ARCHIVE_API_WRANGLER_CONTRACT,
  FORBIDDEN_ARCHIVE_API_BINDINGS,
  type ArchiveApiEnvHasNoForbiddenBindings,
} from '../context';

const noForbiddenOnEnv: ArchiveApiEnvHasNoForbiddenBindings = true;

function contractBindingNames(): string[] {
  return [
    ...ARCHIVE_API_WRANGLER_CONTRACT.kv_namespaces.map((ns) => ns.binding),
    ...(ARCHIVE_API_WRANGLER_CONTRACT.r2_buckets ?? []).map((bucket) => bucket.binding),
    ...(ARCHIVE_API_WRANGLER_CONTRACT.queues?.producers ?? []).map((producer) => producer.binding),
  ];
}

describe('Archive API bindings', () => {
  it('does not bind Body Object, Tinybird, proxy-bucket, or agent-queue secrets', () => {
    const names = contractBindingNames();
    expect(names).toEqual(['COLLECTOR_CREDS', 'ARCHIVE_STORAGE']);
    expect(ARCHIVE_API_WRANGLER_CONTRACT.kv_namespaces).toEqual([
      { binding: 'COLLECTOR_CREDS', id: 'f945ee3d71954ffabd364e3db385d3ab' },
    ]);
    for (const forbidden of FORBIDDEN_ARCHIVE_API_BINDINGS) {
      expect(names).not.toContain(forbidden);
      expect(JSON.stringify(ARCHIVE_API_WRANGLER_CONTRACT)).not.toContain(forbidden);
      expect(env[forbidden]).toBeUndefined();
    }
    expect(env.COLLECTOR_CREDS).toBeDefined();
    expect(env.ARCHIVE_STORAGE).toBeDefined();
    expect(env.AGENT_QUEUE).toBeUndefined();
    expect(ARCHIVE_API_WRANGLER_CONTRACT.r2_buckets).toEqual([
      {
        binding: 'ARCHIVE_STORAGE',
        bucket_name: 'trace-flow-agent-archive-dev',
        jurisdiction: 'us',
      },
    ]);
    expect(ARCHIVE_API_WRANGLER_CONTRACT.durable_objects).toEqual([
      { binding: 'ARCHIVE_SESSION_LEDGER', class_name: 'ArchiveSessionLedger' },
      { binding: 'STORAGE_BUDGET', class_name: 'StorageBudget' },
    ]);
    expect(ARCHIVE_API_WRANGLER_CONTRACT.queues).toBeUndefined();
  });

  it('keeps the Conversation Archive server availability gate disabled by default', () => {
    expect(ARCHIVE_API_WRANGLER_CONTRACT.vars.CONVERSATION_ARCHIVE_ENABLED).not.toBe('true');
    expect(ARCHIVE_API_WRANGLER_CONTRACT.vars.CONVERSATION_ARCHIVE_ENABLED).toBeUndefined();
    expect(env.CONVERSATION_ARCHIVE_ENABLED).not.toBe('true');
  });

  it('types Archive API env without the forbidden secret classes', () => {
    expect(noForbiddenOnEnv).toBe(true);
  });
});
