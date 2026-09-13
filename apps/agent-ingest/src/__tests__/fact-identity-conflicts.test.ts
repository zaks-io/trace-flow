import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type {
  AgentDeliveryReference,
  AgentIngestQueueFacts,
  AgentIngestQueuePayload,
  AgentIngestQueueMessage,
} from '@trace-flow/types';
import { loadAgentDelivery, sha256Hex } from '@trace-flow/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIngestEnv } from '../context';
import {
  AgentFactIdentityConflictError,
  normalizeAgentFactIdentities,
} from '../fact-identity-conflicts';
import { app } from '../index';
import { __resetPolicyCache } from '../policy';
import { envelope, facts, messageFact } from './factories';

const CONVEX = 'https://convex.test';
const SECRET = 'valid-collector-secret';
const ROOT_KEY = btoa('0123456789abcdef'.repeat(2));

const IDENTITY_FIELDS = {
  messages: 'message_pk',
  tool_events: 'tool_use_pk',
  file_events: 'file_event_pk',
  capability_snapshots: 'capability_snapshot_pk',
  pull_request_links: 'pull_request_link_pk',
  review_unit_attributions: 'review_unit_attribution_pk',
} as const;

async function makeEnv(): Promise<{
  env: AgentIngestEnv;
  deliveryPut: ReturnType<typeof vi.fn>;
  registerDelivery: ReturnType<typeof vi.fn>;
  queueSend: ReturnType<typeof vi.fn>;
  deliveryObjects: Map<string, string>;
}> {
  const credentialKey = `collector:${await sha256Hex(SECRET)}`;
  const deliveryObjects = new Map<string, string>();
  const deliveryPut = vi.fn(async (key: string, value: string) => {
    deliveryObjects.set(key, value);
    return { key };
  });
  const registerDelivery = vi.fn(async () => 1);
  const queueSend = vi.fn(async () => {});
  const env = {
    AGENT_INGEST_MAINTENANCE: 'false',
    COLLECTOR_CREDS: {
      get: async (key: string) =>
        key === credentialKey
          ? JSON.stringify({
              orgId: 'org-1',
              userId: 'user-1',
              collectorId: 'collector-1',
              expiresAt: Date.now() + 3_600_000,
              status: 'active',
              createdAt: Date.now(),
            })
          : null,
    } as unknown as KVNamespace,
    AGENT_QUEUE: { sendBatch: queueSend } as unknown as Queue<AgentIngestQueuePayload>,
    AGENT_DELIVERIES: {
      put: deliveryPut,
      get: async (key: string) => {
        const value = deliveryObjects.get(key);
        if (value === undefined) return null;
        return { key, size: value.length, text: async () => value };
      },
    } as unknown as R2Bucket,
    AGENT_CONSUMER: {
      eraseOrganization: async () => {
        throw new Error('Unexpected erasure');
      },
      canAcceptDeliveries: vi.fn(async () => true),
      registerDelivery,
    },
    BODY_ENCRYPTION_ROOT_KEY: ROOT_KEY,
    BODY_ENCRYPTION_KEY_ID: 'v1',
    AGENT_INGEST_LIMITER: { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit,
    CONVEX_SITE_URL: CONVEX,
    AGENT_INGEST_SHARED_SECRET: 'shared-secret',
  } satisfies AgentIngestEnv;
  return { env, deliveryPut, registerDelivery, queueSend, deliveryObjects };
}

async function post(env: AgentIngestEnv, body: unknown): Promise<Response> {
  const request = new Request('https://ingest.test/v1/ingest', {
    method: 'POST',
    headers: {
      'X-Trace-Flow-Collector-Secret': SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const context = createExecutionContext();
  const response = await app.fetch(request, env, context);
  await waitOnExecutionContext(context);
  return response;
}

describe('generated fact identity conflicts', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_001_000);
    __resetPolicyCache();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(Object.entries(IDENTITY_FIELDS))(
    'detects conflicts using the %s natural identity',
    (category, identityField) => {
      const queueFacts = Object.fromEntries(
        Object.keys(IDENTITY_FIELDS).map((key) => [key, []]),
      ) as unknown as AgentIngestQueueFacts;
      const fact = { session_pk: 'session-1', [identityField]: 'fact-1', value: 'first' };
      (queueFacts[category as keyof AgentIngestQueueFacts] as unknown[]).push(fact, {
        ...fact,
        value: 'second',
      });

      expect(() => normalizeAgentFactIdentities(queueFacts)).toThrowError(
        new AgentFactIdentityConflictError(category as keyof AgentIngestQueueFacts),
      );
    },
  );

  it('rejects conflicting values before ownership or delivery state', async () => {
    const claim = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = new Request(input);
      if (request.method === 'GET') {
        return Response.json({
          minDesktopVersion: '1.0.0',
          minParserVersion: '1.0.0',
          denylistedVersions: [],
          updatedAt: Date.now(),
        });
      }
      claim();
      throw new Error('ownership must not be claimed');
    });
    const { env, deliveryPut, registerDelivery, queueSend } = await makeEnv();
    const original = messageFact();
    const body = envelope({
      facts: facts({ messages: [original, { ...original, output_tokens: 21 }] }),
    });

    const response = await post(env, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_envelope' });
    expect(claim).not.toHaveBeenCalled();
    expect(deliveryPut).not.toHaveBeenCalled();
    expect(registerDelivery).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('collapses exact duplicates before delivery', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET') {
        return Response.json({
          minDesktopVersion: '1.0.0',
          minParserVersion: '1.0.0',
          denylistedVersions: [],
          updatedAt: Date.now(),
        });
      }
      const { sessionPks } = await request.json<{ sessionPks: string[] }>();
      return Response.json({
        results: sessionPks.map((sessionPk) => ({
          sessionPk,
          status: 'claimed',
          ownerUserId: 'user-1',
        })),
      });
    });
    const { env, queueSend, deliveryObjects } = await makeEnv();
    const duplicate = messageFact();

    const response = await post(
      env,
      envelope({ facts: facts({ messages: [duplicate, { ...duplicate }] }) }),
    );

    expect(response.status).toBe(202);
    const reference = (queueSend.mock.calls[0]![0] as { body: AgentDeliveryReference }[])[0]!.body;
    const queued: AgentIngestQueueMessage = await loadAgentDelivery({
      storage: env.AGENT_DELIVERIES,
      reference,
      encryption: { rootKeyBase64: ROOT_KEY },
      now: reference.created_at,
    });
    expect(deliveryObjects.size).toBe(1);
    expect(queued.facts.messages).toHaveLength(1);
  });
});
