import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SentryCloudflare from '@sentry/cloudflare';
import type { AgentConsumerEnv } from '../context';
import { processMigratedLegacyMessage, processMigratedLegacyMessages } from '../legacy-delivery';
import { EVENT_AT, queueMessage } from './factories';

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryCloudflare>()),
  captureException: vi.fn(),
}));

const ROOT_KEY = btoa('a'.repeat(32));

describe('legacy inline delivery migration', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(EVENT_AT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves invalid and pre-freeze messages to the legacy caller', async () => {
    const { env, legacyState } = makeEnv({ migrationId: null });
    const invalid = stubMessage({ malformed: true });
    const valid = stubMessage(queueMessage());

    await expect(processMigratedLegacyMessage(invalid, env)).resolves.toBe(false);
    await expect(processMigratedLegacyMessage(valid, env)).resolves.toBe(false);

    expect(legacyState).toHaveBeenCalledOnce();
    expect(invalid.ack).not.toHaveBeenCalled();
    expect(valid.ack).not.toHaveBeenCalled();
  });

  it('rejects without touching the old ledger while the baseline is incomplete', async () => {
    const { env, register } = makeEnv({ migrationComplete: false });
    const message = stubMessage(queueMessage());

    await expect(processMigratedLegacyMessage(message, env)).rejects.toThrow(
      'baseline migration is incomplete',
    );
    expect(register).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('routes stale Queue messages after the retired legacy DO no longer has its freeze marker', async () => {
    const { env, legacyState, register, process } = makeEnv({
      migrationId: null,
      migrationComplete: true,
    });
    const message = stubMessage(queueMessage());

    await expect(processMigratedLegacyMessage(message, env)).resolves.toBe(true);

    expect(legacyState).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('acknowledges an erased organization without staging or preserving the legacy body', async () => {
    const { env, legacyState, register, process, objects } = makeEnv({ erasureStarted: true });
    const message = stubMessage(queueMessage());

    await expect(processMigratedLegacyMessage(message, env)).resolves.toBe(true);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(legacyState).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });

  it('retries a frozen message failure without returning it to the old ledger', async () => {
    const { env } = makeEnv({ migrationComplete: false });
    const message = stubMessage(queueMessage());

    await expect(processMigratedLegacyMessages([message], env)).resolves.toEqual([]);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('acks only after the new durable delivery finishes', async () => {
    let finishProcess!: () => void;
    const processGate = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    const order: string[] = [];
    const { env, process, register } = makeEnv({
      process: vi.fn(async () => {
        order.push('process');
        await processGate;
      }),
    });
    const message = stubMessage(queueMessage(), () => order.push('ack'));

    const running = processMigratedLegacyMessage(message, env);
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    expect(message.ack).not.toHaveBeenCalled();
    finishProcess();

    await expect(running).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent-delivery', org_id: 'org-1' }),
      ['2026-05-20'],
    );
    expect(order).toEqual(['process', 'ack']);
  });

  it('acks expired-only deliveries without writing data outside retention', async () => {
    const now = Date.UTC(2026, 8, 13);
    vi.mocked(Date.now).mockReturnValue(now);
    const expired = queueMessage({
      facts: {
        messages: [
          {
            ...queueMessage().facts.messages[0]!,
            event_at: now - 366 * 24 * 60 * 60 * 1_000,
          },
        ],
        tool_events: [],
        file_events: [],
        capability_snapshots: [],
        pull_request_links: [],
        review_unit_attributions: [],
      },
    });
    const { env, register, process } = makeEnv();
    const message = stubMessage(expired);

    await expect(processMigratedLegacyMessage(message, env)).resolves.toBe(true);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('retries a future-day delivery without staging or acking it', async () => {
    const now = Date.UTC(2026, 8, 13);
    vi.mocked(Date.now).mockReturnValue(now);
    const future = queueMessage({
      facts: {
        messages: [
          {
            ...queueMessage().facts.messages[0]!,
            event_at: now + 24 * 60 * 60 * 1_000,
          },
        ],
        tool_events: [],
        file_events: [],
        capability_snapshots: [],
        pull_request_links: [],
        review_unit_attributions: [],
      },
    });
    const { env, register, process } = makeEnv();
    const message = stubMessage(future);

    await expect(processMigratedLegacyMessages([message], env)).resolves.toEqual([]);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('assigns a fresh revision when the same old Queue body is replayed', async () => {
    let revision = 0;
    const register = vi.fn(async () => (revision += 1));
    const { env, process } = makeEnv({ register });
    const first = stubMessage(queueMessage());
    const replay = stubMessage(queueMessage());

    await processMigratedLegacyMessage(first, env);
    await processMigratedLegacyMessage(replay, env);

    const references = process.mock.calls.map(([reference]) => reference);
    expect(references.map((reference) => reference.delivery_revision)).toEqual([1, 2]);
    expect(references[0]!.key).not.toBe(references[1]!.key);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(replay.ack).toHaveBeenCalledOnce();
  });

  it('processes at most six legacy checks concurrently and returns unhandled messages in order', async () => {
    let active = 0;
    let maxActive = 0;
    const legacyState = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { migrationId: null, queuedRows: 0, flushing: false };
    });
    const { env } = makeEnv({ legacyState, migrationComplete: false });
    const messages = Array.from({ length: 13 }, (_, index) =>
      stubMessage(queueMessage({ collector_batch_id: `batch-${index}` })),
    );

    await expect(processMigratedLegacyMessages(messages, env)).resolves.toEqual(messages);
    expect(maxActive).toBe(6);
    expect(messages.every((message) => message.ack.mock.calls.length === 0)).toBe(true);
  });
});

function makeEnv(
  options: {
    migrationId?: string | null;
    migrationComplete?: boolean;
    legacyState?: ReturnType<typeof vi.fn>;
    register?: ReturnType<typeof vi.fn>;
    process?: ReturnType<typeof vi.fn>;
    erasureStarted?: boolean;
  } = {},
) {
  const objects = new Map<string, string>();
  const legacyState =
    options.legacyState ??
    vi.fn(async () => ({
      migrationId:
        options.migrationId === undefined ? 'bounded-agent-ingestion-v1' : options.migrationId,
      queuedRows: 0,
      flushing: false,
    }));
  const migrationState = vi.fn(async () => ({
    proofSha256: 'a'.repeat(64),
    complete: options.migrationComplete ?? options.migrationId !== null,
  }));
  const register = options.register ?? vi.fn(async () => 7);
  const process = options.process ?? vi.fn(async () => undefined);
  const delivery = { register, process };
  const env = {
    AGENT_FACT_BATCHER: { getByName: vi.fn(() => ({ getIngestionMigrationState: legacyState })) },
    AGENT_DELIVERY_COORDINATOR: {
      getByName: vi.fn(() => ({
        getErasureState: vi.fn(async () =>
          options.erasureStarted
            ? {
                erasureStarted: true,
                startedAt: Date.now(),
                activeDeliveries: 0,
                incompleteDays: 0,
                activeSnapshotGeneration: null,
                outstandingCopyIntents: 0,
                ready: true,
              }
            : null,
        ),
        getIngestionMigrationState: migrationState,
      })),
    },
    AGENT_DELIVERY: { getByName: vi.fn(() => delivery) },
    AGENT_DELIVERIES: {
      put: vi.fn(async (key: string, value: string) => {
        objects.set(key, value);
        return { key };
      }),
    },
    BODY_ENCRYPTION_ROOT_KEY: ROOT_KEY,
  } as unknown as AgentConsumerEnv;
  return { env, legacyState, migrationState, objects, process, register };
}

function stubMessage(body: unknown, onAck: () => void = () => undefined) {
  return {
    id: crypto.randomUUID(),
    body,
    ack: vi.fn(onAck),
    retry: vi.fn(),
  } as unknown as Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}
