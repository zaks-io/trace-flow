import { describe, expect, it } from 'vitest';
import {
  loadDeliveryRows,
  priceDelivery,
  storeDeliveryRows,
  storeDeliveryRowsOnce,
  versionDeliveryRows,
} from '../delivery-rows';
import { emptyQueueFacts, messageFact, queueMessage } from './factories';
import { makeKv } from './harness';

const encryptionKey = btoa('a'.repeat(32));

function memoryStorage() {
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, value: string, options?: R2PutOptions) {
      if (options?.onlyIf && objects.has(key)) return null;
      objects.set(key, value);
      return { key };
    },
    async get(key: string) {
      const text = objects.get(key);
      return text === undefined
        ? null
        : {
            size: new TextEncoder().encode(text).byteLength,
            async json() {
              return JSON.parse(text);
            },
          };
    },
  } as unknown as R2Bucket;
  return { objects, env: { AGENT_DELIVERIES: bucket, BODY_ENCRYPTION_ROOT_KEY: encryptionKey } };
}

describe('priced delivery persistence', () => {
  it('collapses identical identities but rejects conflicting values within one revision', async () => {
    const { kv } = makeKv({});
    const fact = messageFact();
    const message = queueMessage({ facts: { ...emptyQueueFacts(), messages: [fact, fact] } });
    const result = await priceDelivery(message, 17, Date.now() + 60_000, kv);
    expect(result.rows.messages).toHaveLength(1);
    expect(result.rows.messages[0]).toMatchObject({ DeliverySequence: 17 });
    message.facts.messages[1] = { ...fact, output_tokens: fact.output_tokens + 1 };
    await expect(priceDelivery(message, 17, Date.now() + 60_000, kv)).rejects.toThrow(
      'Conflicting messages identities',
    );
  });

  it('preserves the priced value across retries and binds ciphertext to tenant, key and revision', async () => {
    const { kv } = makeKv({});
    const delivery = await priceDelivery(queueMessage(), 12, Date.now() + 60_000, kv);
    const { objects, env } = memoryStorage();
    const key = 'agent-delivery-rows/test';
    const sha256 = await storeDeliveryRows(env, key, delivery);
    const expected = { orgId: delivery.orgId, revision: 12, expiresAt: delivery.expiresAt, sha256 };
    expect(objects.get(key)).not.toContain('input_tokens');
    expect(await loadDeliveryRows(env, key, expected)).toEqual(delivery);
    await expect(loadDeliveryRows(env, key, { ...expected, revision: 13 })).rejects.toThrow(
      'contract mismatch',
    );
    await expect(
      loadDeliveryRows(env, key, { ...expected, orgId: 'another-org' }),
    ).rejects.toThrow();
    objects.set('agent-delivery-rows/other', objects.get(key)!);
    await expect(loadDeliveryRows(env, 'agent-delivery-rows/other', expected)).rejects.toThrow();
  });

  it('rejects expired data before reading the stored body', async () => {
    const { env } = memoryStorage();
    await expect(
      loadDeliveryRows(env, 'missing', {
        orgId: 'org',
        revision: 1,
        expiresAt: Date.now() - 1,
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow('expired');
  });

  it('never overwrites an immutable recovery source with a reused delivery key', async () => {
    const { kv } = makeKv({});
    const original = await priceDelivery(queueMessage(), 1, Date.now() + 60_000, kv);
    const { env } = memoryStorage();
    const key = 'agent-deliveries/org-1/2c345e67-e89b-42d3-a456-426614174000';
    const sha256 = await storeDeliveryRowsOnce(env, key, original);
    await expect(storeDeliveryRowsOnce(env, key, original)).resolves.toBe(sha256);
    const changed = {
      ...original,
      rows: {
        ...original.rows,
        messages: [{ ...(original.rows.messages[0] as object), cost_usd: 99 }],
      },
    };
    await expect(storeDeliveryRowsOnce(env, key, changed)).rejects.toThrow('integrity');
    await expect(
      loadDeliveryRows(env, key, {
        orgId: original.orgId,
        revision: original.revision,
        expiresAt: original.expiresAt,
        sha256,
      }),
    ).resolves.toEqual(original);
  });

  it('reversions priced recovery rows and validates tenant, identity, and partition day', async () => {
    const { kv } = makeKv({});
    const source = await priceDelivery(queueMessage(), 1, Date.now() + 60_000, kv);
    const row = source.rows.messages[0] as Record<string, unknown>;
    const contract = { orgId: source.orgId, revision: 27, expiresAt: source.expiresAt };

    const versioned = await versionDeliveryRows(
      { ...source.rows, messages: [row, { ...row }] },
      contract,
    );
    expect(versioned.rows.messages).toHaveLength(1);
    expect(versioned.rows.messages[0]).toMatchObject({
      DeliverySequence: 27,
      IsDeleted: 0,
    });
    expect(versioned.rows.messages[0]).not.toEqual(row);

    await expect(
      versionDeliveryRows(
        {
          ...source.rows,
          messages: [{ ...row, OrgId: 'another-org' }],
        },
        contract,
      ),
    ).rejects.toThrow('row organization');
    await expect(
      versionDeliveryRows(
        {
          ...source.rows,
          messages: [{ ...row, message_pk: '' }],
        },
        contract,
      ),
    ).rejects.toThrow('row identity');
    await expect(
      versionDeliveryRows(
        {
          ...source.rows,
          messages: [{ ...row, EventAt: 'not-a-day' }],
        },
        contract,
      ),
    ).rejects.toThrow('invalid EventAt');
  });

  it('rejects conflicting priced recovery rows with the same identity', async () => {
    const { kv } = makeKv({});
    const source = await priceDelivery(queueMessage(), 1, Date.now() + 60_000, kv);
    const row = source.rows.messages[0] as Record<string, unknown>;

    await expect(
      versionDeliveryRows(
        {
          ...source.rows,
          messages: [row, { ...row, cost_usd: 123 }],
        },
        {
          orgId: source.orgId,
          revision: 2,
          expiresAt: source.expiresAt,
        },
      ),
    ).rejects.toThrow('Conflicting messages identities');
  });
});
