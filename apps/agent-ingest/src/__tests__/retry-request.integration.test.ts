import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  agentDeliveryCanonicalJson,
  sha256Hex,
  MAX_AGENT_DELIVERY_AGE_MS,
} from '@trace-flow/utils';
import { CollectorBatchConflictError, recordCollectorRequest } from '../retry-request';
import { envelope } from './factories';

const storage = (env as unknown as { AGENT_DELIVERIES: R2Bucket }).AGENT_DELIVERIES;

async function request(body: ReturnType<typeof envelope>) {
  return {
    batchId: body.batch.collector_batch_id,
    digest: await sha256Hex(agentDeliveryCanonicalJson(body)),
  };
}

describe('Collector request manifests on R2', () => {
  it('conditionally preserves one manifest across concurrent retries and its original expiry', async () => {
    const org = `request-${crypto.randomUUID()}`;
    const body = envelope();
    const now = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, async () =>
        recordCollectorRequest(storage, org, 'collector', await request(body), now),
      ),
    );
    const listed = await storage.list({ prefix: `agent-deliveries/${org}/requests/` });
    expect(listed.objects).toHaveLength(1);
    const original = await storage.get(listed.objects[0]!.key);
    const serialized = await original!.text();
    await recordCollectorRequest(storage, org, 'collector', await request(body), now + 1000);
    expect(await (await storage.get(original!.key))!.text()).toBe(serialized);
    await expect(
      recordCollectorRequest(
        storage,
        org,
        'collector',
        await request(body),
        now + MAX_AGENT_DELIVERY_AGE_MS,
      ),
    ).rejects.toBeInstanceOf(CollectorBatchConflictError);
  });

  it('rejects different content under the same tenant and Collector batch identity', async () => {
    const org = `request-${crypto.randomUUID()}`;
    const body = envelope();
    const now = Date.now();
    await recordCollectorRequest(storage, org, 'collector', await request(body), now);
    const changed = structuredClone(body);
    changed.facts.messages[0]!.input_tokens += 1;
    await expect(
      recordCollectorRequest(storage, org, 'collector', await request(changed), now),
    ).rejects.toBeInstanceOf(CollectorBatchConflictError);
    await expect(
      recordCollectorRequest(storage, org, 'other-collector', await request(changed), now),
    ).resolves.toBeUndefined();
    await expect(
      recordCollectorRequest(storage, `${org}-other`, 'collector', await request(changed), now),
    ).resolves.toBeUndefined();
  });
});
