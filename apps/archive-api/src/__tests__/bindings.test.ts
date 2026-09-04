import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  ARCHIVE_API_WRANGLER_CONTRACT,
  FORBIDDEN_ARCHIVE_API_BINDINGS,
  type ArchiveApiEnv,
  type ArchiveApiEnvHasNoForbiddenBindings,
} from '../context';

const _noForbiddenOnEnv: ArchiveApiEnvHasNoForbiddenBindings = true;
void _noForbiddenOnEnv;

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
    expect(names).toEqual(['COLLECTOR_CREDS']);
    expect(ARCHIVE_API_WRANGLER_CONTRACT.kv_namespaces).toEqual([
      { binding: 'COLLECTOR_CREDS', id: 'f945ee3d71954ffabd364e3db385d3ab' },
    ]);
    for (const forbidden of FORBIDDEN_ARCHIVE_API_BINDINGS) {
      expect(names).not.toContain(forbidden);
      expect(JSON.stringify(ARCHIVE_API_WRANGLER_CONTRACT)).not.toContain(forbidden);
      expect(env[forbidden]).toBeUndefined();
    }
    expect(env.COLLECTOR_CREDS).toBeDefined();
    expect(env.STORAGE).toBeUndefined();
    expect(env.AGENT_QUEUE).toBeUndefined();
    expect(ARCHIVE_API_WRANGLER_CONTRACT.r2_buckets).toBeUndefined();
    expect(ARCHIVE_API_WRANGLER_CONTRACT.queues).toBeUndefined();
  });

  it('keeps the Conversation Archive server availability gate disabled by default', () => {
    expect(ARCHIVE_API_WRANGLER_CONTRACT.vars.CONVERSATION_ARCHIVE_ENABLED).not.toBe('true');
    expect(ARCHIVE_API_WRANGLER_CONTRACT.vars.CONVERSATION_ARCHIVE_ENABLED).toBeUndefined();
    expect(env.CONVERSATION_ARCHIVE_ENABLED).not.toBe('true');
  });

  it('types Archive API env without the forbidden secret classes', () => {
    type ForbiddenOnEnv = keyof ArchiveApiEnv & (typeof FORBIDDEN_ARCHIVE_API_BINDINGS)[number];
    type AssertNone = [ForbiddenOnEnv] extends [never] ? true : false;
    const none: AssertNone = true;
    expect(none).toBe(true);
  });
});
