import { vi } from 'vitest';
import { sha256Hex } from '@trace-flow/utils';
import type { AgentDeliveryStagedReference, AgentIngestQueuePayload } from '@trace-flow/types';
import type { AgentConsumerService, AgentIngestEnv } from '../context';
import type { CompatibilityPolicy } from '../policy';

export const CONVEX = 'https://convex.test';
export const SECRET = 'valid-collector-secret';
export const ROOT_KEY = btoa('0123456789abcdef'.repeat(2));
export const TEST_NOW = 1_700_000_001_000;

export const POLICY: CompatibilityPolicy = {
  minDesktopVersion: '1.0.0',
  minParserVersion: '1.0.0',
  denylistedVersions: [],
  updatedAt: 1_700_000_000_000,
};

function makeKv(entries: Record<string, string>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace;
}

interface EnvOverrides {
  creds?: Record<string, string>;
  limitSuccess?: boolean;
  queueSend?: ReturnType<typeof vi.fn>;
  deliveryPut?: ReturnType<typeof vi.fn>;
  canAcceptDeliveries?: AgentConsumerService['canAcceptDeliveries'];
  registerDelivery?: AgentConsumerService['registerDelivery'];
  getDeliveryReceipt?: AgentConsumerService['getDeliveryReceipt'];
}

export async function validCredEntries(
  over: Partial<Record<string, unknown>> = {},
): Promise<Record<string, string>> {
  const key = `collector:${await sha256Hex(SECRET)}`;
  return {
    [key]: JSON.stringify({
      orgId: 'org-1',
      userId: 'user-1',
      collectorId: 'collector-1',
      expiresAt: Date.now() + 3_600_000,
      status: 'active',
      createdAt: Date.now(),
      ...over,
    }),
  };
}

export function makeEnv(over: EnvOverrides = {}): {
  env: AgentIngestEnv;
  queueSend: ReturnType<typeof vi.fn>;
  rateLimit: ReturnType<typeof vi.fn>;
  deliveryObjects: Map<string, string>;
} {
  const queueSend = over.queueSend ?? vi.fn(async () => {});
  const rateLimit = vi.fn(async () => ({ success: over.limitSuccess ?? true }));
  const deliveryObjects = new Map<string, string>();
  const receipts = new Map<string, { reference: AgentDeliveryStagedReference; revision: number }>();
  let nextRevision = 0;
  const canAcceptDeliveries: AgentConsumerService['canAcceptDeliveries'] =
    over.canAcceptDeliveries ?? vi.fn(async () => true);
  const registerDelivery: AgentConsumerService['registerDelivery'] =
    over.registerDelivery ??
    vi.fn(async (reference: AgentDeliveryStagedReference) => {
      const existing = receipts.get(reference.key);
      if (existing) {
        if (JSON.stringify(existing.reference) !== JSON.stringify(reference)) {
          throw new Error('Delivery registration conflict');
        }
        return existing.revision;
      }
      const revision = (nextRevision += 1);
      receipts.set(reference.key, { reference, revision });
      return revision;
    });
  const deliveryPut =
    over.deliveryPut ??
    vi.fn(async (key: string, value: string) => {
      if (deliveryObjects.has(key)) return null;
      deliveryObjects.set(key, value);
      return { key };
    });
  const deliveries = {
    put: deliveryPut,
    delete: vi.fn(async (key: string) => {
      deliveryObjects.delete(key);
    }),
    get: vi.fn(async (key: string) => {
      const value = deliveryObjects.get(key);
      if (value === undefined) return null;
      return {
        key,
        size: new TextEncoder().encode(value).byteLength,
        text: async () => value,
        json: async () => JSON.parse(value) as unknown,
      };
    }),
  } as unknown as R2Bucket;
  const env = {
    AGENT_INGEST_MAINTENANCE: 'false',
    COLLECTOR_CREDS: makeKv(over.creds ?? {}),
    // The handler enqueues via sendBatch (one call per <=100-message group). Tests assert on it.
    AGENT_QUEUE: { sendBatch: queueSend } as unknown as Queue<AgentIngestQueuePayload>,
    AGENT_DELIVERIES: deliveries,
    AGENT_CONSUMER: {
      canAcceptDeliveries,
      registerDelivery,
      getDeliveryReceipt:
        over.getDeliveryReceipt ??
        vi.fn(async (key: string) => receipts.get(key)?.reference ?? null),
      eraseOrganization: async () => {
        throw new Error('Unexpected erasure');
      },
    },
    BODY_ENCRYPTION_ROOT_KEY: ROOT_KEY,
    BODY_ENCRYPTION_KEY_ID: 'v1',
    AGENT_INGEST_LIMITER: {
      limit: rateLimit,
    } as unknown as RateLimit,
    CONVEX_SITE_URL: CONVEX,
    AGENT_INGEST_SHARED_SECRET: 'shared-secret',
  } satisfies AgentIngestEnv;
  return { env, queueSend, rateLimit, deliveryObjects };
}
