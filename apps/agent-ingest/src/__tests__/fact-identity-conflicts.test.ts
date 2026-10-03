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
import { assembleQueueFacts } from '../ids';
import { app } from '../index';
import { __resetPolicyCache } from '../policy';
import { emptyFacts, envelope, facts, messageFact, toolEventFact } from './factories';

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

async function queueFactsFor(
  over: Partial<ReturnType<typeof emptyFacts>>,
): Promise<AgentIngestQueueFacts> {
  return (await assembleQueueFacts({ ...emptyFacts(), ...over }, 'claude')).queueFacts;
}

function conflictOf(queueFacts: AgentIngestQueueFacts): AgentFactIdentityConflictError {
  try {
    normalizeAgentFactIdentities(queueFacts);
  } catch (err) {
    if (err instanceof AgentFactIdentityConflictError) return err;
    throw err;
  }
  throw new Error('expected an identity conflict');
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

function acceptAllClaims(): ReturnType<typeof vi.fn> {
  const claim = vi.fn();
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
    claim();
    const { sessionPks } = await request.json<{ sessionPks: string[] }>();
    return Response.json({
      results: sessionPks.map((sessionPk) => ({
        sessionPk,
        status: 'claimed',
        ownerUserId: 'user-1',
      })),
    });
  });
  return claim;
}

async function firstQueued(
  env: AgentIngestEnv,
  queueSend: ReturnType<typeof vi.fn>,
): Promise<AgentIngestQueueMessage> {
  const reference = (queueSend.mock.calls[0]![0] as { body: AgentDeliveryReference }[])[0]!.body;
  return loadAgentDelivery({
    storage: env.AGENT_DELIVERIES,
    reference,
    encryption: { rootKeyBase64: ROOT_KEY },
    now: reference.created_at,
  });
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

      expect(conflictOf(queueFacts).category).toBe(category);
    },
  );

  it('collapses messages that differ only by turn index to the lowest turn', async () => {
    const original = messageFact({ turn_index: 2 });
    const reappended = { ...original, turn_index: 9 };

    for (const messages of [
      [reappended, original],
      [original, reappended],
    ]) {
      const normalized = normalizeAgentFactIdentities(await queueFactsFor({ messages }));

      expect(normalized.messages).toHaveLength(1);
      expect(normalized.messages[0]!.turn_index).toBe(2);
    }
  });

  it('collapses tool events that differ only by block index to the lowest block', async () => {
    const original = toolEventFact({ source_block_index: 1 });
    const tool_events = [{ ...original, source_block_index: 4 }, original];

    const normalized = normalizeAgentFactIdentities(await queueFactsFor({ tool_events }));

    expect(normalized.tool_events).toHaveLength(1);
    expect(normalized.tool_events[0]!.source_block_index).toBe(1);
  });

  it('collapses snapshots and links that differ only by stable turn index', async () => {
    const snapshot = facts().capability_snapshots[0]!;
    const link = facts().pull_request_links[0]!;

    const normalized = normalizeAgentFactIdentities(
      await queueFactsFor({
        capability_snapshots: [{ ...snapshot, stable_turn_index: 5 }, snapshot],
        pull_request_links: [{ ...link, stable_turn_index: 5 }, link],
      }),
    );

    expect(normalized.capability_snapshots).toEqual([
      expect.objectContaining({ stable_turn_index: 0 }),
    ]);
    expect(normalized.pull_request_links).toEqual([
      expect.objectContaining({ stable_turn_index: 0 }),
    ]);
  });

  it('keeps positional identities distinct when no vendor id owns the identity', async () => {
    const codex = messageFact({ vendor_message_id: null, turn_index: 0 });

    const normalized = normalizeAgentFactIdentities(
      await queueFactsFor({ messages: [codex, { ...codex, turn_index: 1 }] }),
    );

    expect(normalized.messages.map((message) => message.turn_index)).toEqual([0, 1]);
  });

  it('still conflicts when a position-only duplicate also differs in another field', async () => {
    const original = messageFact({ vendor_session_id: 'vsid-2', turn_index: 2 });
    const queueFacts = await queueFactsFor({
      messages: [original, { ...original, turn_index: 9, output_tokens: 21 }],
    });

    const conflict = conflictOf(queueFacts);

    expect(conflict.category).toBe('messages');
    expect(conflict.vendorSessionIds).toEqual(['vsid-2']);
    expect(conflict.conflicts).toEqual([
      { vendorSessionId: 'vsid-2', identityPk: queueFacts.messages[0]!.message_pk },
    ]);
  });

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
    expect(await response.json()).toEqual({
      error: 'invalid_envelope',
      reason: 'fact_identity_conflict',
      category: 'messages',
      vendor_session_ids: ['vsid-1'],
    });
    expect(claim).not.toHaveBeenCalled();
    expect(deliveryPut).not.toHaveBeenCalled();
    expect(registerDelivery).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('collapses exact duplicates before delivery', async () => {
    acceptAllClaims();
    const { env, queueSend, deliveryObjects } = await makeEnv();
    const duplicate = messageFact();

    const response = await post(
      env,
      envelope({ facts: facts({ messages: [duplicate, { ...duplicate }] }) }),
    );

    expect(response.status).toBe(202);
    const queued = await firstQueued(env, queueSend);
    expect(deliveryObjects.size).toBe(1);
    expect(queued.facts.messages).toHaveLength(1);
  });

  it('202s a compact_boundary re-append that repeats ids at later positions', async () => {
    acceptAllClaims();
    const { env, queueSend } = await makeEnv();
    const message = messageFact({ turn_index: 3 });
    const tool = toolEventFact({ source_block_index: 1 });
    const body = envelope({
      facts: facts({
        messages: [message, { ...message, turn_index: 40 }],
        tool_events: [tool, { ...tool, source_block_index: 6 }],
      }),
    });

    const response = await post(env, body);

    expect(response.status).toBe(202);
    const queued = await firstQueued(env, queueSend);
    expect(queued.facts.messages.map((fact) => fact.turn_index)).toEqual([3]);
    expect(queued.facts.tool_events.map((fact) => fact.source_block_index)).toEqual([1]);
  });

  it('400s a genuine conflict naming only the affected vendor session', async () => {
    const claim = acceptAllClaims();
    const { env, queueSend } = await makeEnv();
    const tool = toolEventFact({ vendor_session_id: 'vsid-bad' });
    const body = envelope({
      facts: facts({
        tool_events: [tool, { ...tool, source_block_index: 2, status: 'failure' }],
      }),
    });

    const response = await post(env, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_envelope',
      reason: 'fact_identity_conflict',
      category: 'tool_events',
      vendor_session_ids: ['vsid-bad'],
    });
    expect(claim).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });
});
