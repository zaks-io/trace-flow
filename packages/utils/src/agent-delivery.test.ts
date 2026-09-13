import { describe, expect, it, vi } from 'vitest';
import type {
  AgentDeliveryEnvelope,
  AgentDeliveryReference,
  AgentDeliveryStagedReference,
  AgentIngestQueueMessage,
} from '@trace-flow/types';
import {
  AgentDeliveryError,
  loadAgentDelivery,
  MAX_AGENT_DELIVERY_AGE_MS,
  MAX_AGENT_DELIVERY_OBJECT_BYTES,
  stageAgentDelivery,
  validateAgentDeliveryReference,
} from './agent-delivery';
import { encryptStoredBodyPayload, sha256Hex } from './crypto';

const ROOT_KEY = btoa('0123456789abcdef'.repeat(2));
const NOW = 1_700_000_000_000;

function message(): AgentIngestQueueMessage {
  return {
    type: 'agent',
    source: 'claude',
    parser_version: '1.0.0',
    desktop_version: '1.0.0',
    collector_batch_id: 'batch-1',
    tenancy: {
      org_id: 'org-1',
      user_id: 'user-1',
      collector_id: 'collector-1',
      collector_credential_id: 'credential-1',
    },
    facts: {
      messages: [],
      tool_events: [],
      file_events: [],
      capability_snapshots: [],
      pull_request_links: [],
      review_unit_attributions: [],
    },
    enqueued_at: NOW,
  };
}

function memoryBucket() {
  const values = new Map<string, string>();
  const metadata = new Map<string, Record<string, string>>();
  const put = vi.fn(async (key: string, value: string, options?: R2PutOptions) => {
    values.set(key, value);
    metadata.set(key, options?.customMetadata ?? {});
    return { key };
  });
  const get = vi.fn(async (key: string) => {
    const value = values.get(key);
    if (value === undefined) return null;
    return {
      key,
      size: new TextEncoder().encode(value).byteLength,
      text: async () => value,
      customMetadata: metadata.get(key),
    };
  });
  return {
    values,
    metadata,
    put,
    get,
    bucket: { put, get } as unknown as R2Bucket,
  };
}

async function staged() {
  const memory = memoryBucket();
  const reference = await stageAgentDelivery({
    storage: memory.bucket,
    message: message(),
    encryption: { rootKeyBase64: ROOT_KEY, keyId: 'v1' },
    now: NOW,
  });
  return { memory, reference };
}

function registered(reference: AgentDeliveryStagedReference): AgentDeliveryReference {
  return { ...reference, delivery_revision: 1 };
}

describe('agent delivery storage', () => {
  it('persists encrypted bytes before returning a small fact-free reference', async () => {
    const { memory, reference } = await staged();
    const stored = memory.values.get(reference.key)!;

    expect(reference).toMatchObject({
      type: 'agent-delivery',
      version: 1,
      org_id: 'org-1',
      created_at: NOW,
      expires_at: NOW + MAX_AGENT_DELIVERY_AGE_MS,
    });
    expect(reference.key).toMatch(/^agent-deliveries\/org-1\/[0-9a-f-]{36}$/u);
    expect(reference.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(validateAgentDeliveryReference(reference)).toBe('delivery_revision');
    expect(validateAgentDeliveryReference({ ...reference, delivery_revision: 0 })).toBe(
      'delivery_revision',
    );
    expect(validateAgentDeliveryReference({ ...reference, delivery_revision: 1 })).toBeNull();
    expect(JSON.stringify(reference)).not.toContain('facts');
    expect(stored).not.toContain('collector_batch_id');
    expect(stored).not.toContain('batch-1');
    expect(memory.metadata.get(reference.key)).toEqual({
      orgId: 'org-1',
      expiresAt: String(NOW + MAX_AGENT_DELIVERY_AGE_MS),
    });
    await expect(
      loadAgentDelivery({
        storage: memory.bucket,
        reference: registered(reference),
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).resolves.toEqual(message());
  });

  it('rejects ciphertext tampering and object-key AAD substitution', async () => {
    const { memory, reference } = await staged();
    const envelope = JSON.parse(memory.values.get(reference.key)!) as AgentDeliveryEnvelope;
    const first = envelope.encryptedPayload.data[0]!;
    envelope.encryptedPayload.data = `${first === 'A' ? 'B' : 'A'}${envelope.encryptedPayload.data.slice(1)}`;
    memory.values.set(reference.key, JSON.stringify(envelope));

    await expect(
      loadAgentDelivery({
        storage: memory.bucket,
        reference: registered(reference),
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'decryption_failed' });

    const clean = await staged();
    const substituted = {
      ...clean.reference,
      key: 'agent-deliveries/org-1/00000000-0000-4000-8000-000000000000',
      delivery_revision: 1,
    };
    clean.memory.get.mockImplementationOnce(async () => {
      const value = clean.memory.values.get(clean.reference.key)!;
      return {
        key: substituted.key,
        size: new TextEncoder().encode(value).byteLength,
        text: async () => value,
        customMetadata: undefined,
      };
    });
    await expect(
      loadAgentDelivery({
        storage: clean.memory.bucket,
        reference: substituted,
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'decryption_failed' });
  });

  it('rejects tenant and plaintext-hash substitution', async () => {
    const tenant = await staged();
    await expect(
      loadAgentDelivery({
        storage: tenant.memory.bucket,
        reference: { ...registered(tenant.reference), org_id: 'org-2' },
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'reference.key_org' });

    const hash = await staged();
    const wrongHash = '0'.repeat(64);
    const envelope = JSON.parse(
      hash.memory.values.get(hash.reference.key)!,
    ) as AgentDeliveryEnvelope;
    hash.memory.values.set(hash.reference.key, JSON.stringify({ ...envelope, sha256: wrongHash }));
    await expect(
      loadAgentDelivery({
        storage: hash.memory.bucket,
        reference: { ...registered(hash.reference), sha256: wrongHash },
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
  });

  it('validates the decrypted body against the inline Queue contract', async () => {
    const memory = memoryBucket();
    const key = 'agent-deliveries/org-1/00000000-0000-4000-8000-000000000000';
    const plaintext = JSON.stringify({ ...message(), type: 'rogue' });
    const sha256 = await sha256Hex(plaintext);
    const encryptedPayload = await encryptStoredBodyPayload(plaintext, {
      rootKeyBase64: ROOT_KEY,
      orgId: 'org-1',
      objectKey: key,
    });
    memory.values.set(
      key,
      JSON.stringify({
        version: 1,
        created_at: NOW,
        expires_at: NOW + MAX_AGENT_DELIVERY_AGE_MS,
        sha256,
        encryptedPayload,
      } satisfies AgentDeliveryEnvelope),
    );
    const reference: AgentDeliveryReference = {
      type: 'agent-delivery',
      version: 1,
      key,
      org_id: 'org-1',
      sha256,
      created_at: NOW,
      expires_at: NOW + MAX_AGENT_DELIVERY_AGE_MS,
      delivery_revision: 1,
    };

    await expect(
      loadAgentDelivery({
        storage: memory.bucket,
        reference,
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: expect.stringContaining('queue_message') });
  });

  it('rejects expired and future references before reading R2', async () => {
    const { memory, reference } = await staged();
    await expect(
      loadAgentDelivery({
        storage: memory.bucket,
        reference: registered(reference),
        encryption: { rootKeyBase64: ROOT_KEY },
        now: reference.expires_at,
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(memory.get).not.toHaveBeenCalled();

    const future: AgentDeliveryReference = {
      ...registered(reference),
      created_at: NOW + 60_001,
      expires_at: NOW + 60_001 + MAX_AGENT_DELIVERY_AGE_MS,
    };
    await expect(
      loadAgentDelivery({
        storage: memory.bucket,
        reference: future,
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'created_in_future' });
    expect(memory.get).not.toHaveBeenCalled();
  });

  it('rejects oversized objects before reading their body', async () => {
    const { reference } = await staged();
    const text = vi.fn(async () => 'must not load');
    const storage = {
      get: vi.fn(async () => ({
        key: reference.key,
        size: MAX_AGENT_DELIVERY_OBJECT_BYTES + 1,
        text,
      })),
    } as unknown as R2Bucket;

    await expect(
      loadAgentDelivery({
        storage,
        reference: registered(reference),
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'object_too_large' });
    expect(text).not.toHaveBeenCalled();
  });

  it('fails when R2 does not durably accept the encrypted object', async () => {
    const rejected = {
      put: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
    } as unknown as R2Bucket;
    const collision = {
      put: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;

    await expect(
      stageAgentDelivery({
        storage: rejected,
        message: message(),
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toThrow('R2 unavailable');
    await expect(
      stageAgentDelivery({
        storage: collision,
        message: message(),
        encryption: { rootKeyBase64: ROOT_KEY },
        now: NOW,
      }),
    ).rejects.toEqual(new AgentDeliveryError('key_collision'));
  });
});
