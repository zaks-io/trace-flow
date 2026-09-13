import type { AgentSnapshotProgress } from '../agent-delivery-coordinator-contract';
import type { AgentSnapshotCopyIntent } from '../agent-ingestion-erasure';
import type { AgentConsumerEnv } from '../context';
import type { SnapshotPlan } from '../snapshot-tinybird';
import { vi } from 'vitest';

interface FixtureOptions {
  initialStats?: Record<string, unknown>;
  finalStats?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

export function makeSnapshotRunner(
  snapshot: Omit<SnapshotPlan, 'orgId'>,
  options: FixtureOptions = {},
) {
  let nextCopyIndex = 0;
  let claimId: string | undefined;
  let manifestPublishedAtMs: number | undefined;
  let intents: AgentSnapshotCopyIntent[] = [];
  const totalCopies = Math.ceil(snapshot.dirtyDays.length / 31) * 9;
  const progress = (): AgentSnapshotProgress => ({
    ...snapshot,
    nextCopyIndex,
    totalCopies,
    claimId: claimId ?? 'unclaimed',
    claimExpiresAtMs: Date.now() + 5 * 60_000,
    ...(manifestPublishedAtMs === undefined ? {} : { manifestPublishedAtMs }),
  });
  const coordinator = {
    getStats: vi
      .fn()
      .mockResolvedValueOnce(snapshotStats(options.initialStats))
      .mockResolvedValue(snapshotStats({ dirtyDays: 0, ...options.finalStats })),
    requestSnapshot: vi.fn().mockResolvedValue({ status: 'draining', activeDeliveries: 0 }),
    beginSnapshot: vi.fn(async ({ claimId: owner }: { claimId: string }) => {
      claimId = owner;
      return snapshot;
    }),
    claimSnapshot: vi.fn(async ({ claimId: owner }: { claimId: string }) => {
      claimId = owner;
      return progress();
    }),
    getSnapshotProgress: vi.fn(async () => progress()),
    renewSnapshotClaim: vi.fn(async () => progress()),
    releaseSnapshotClaim: vi.fn(async () => progress()),
    scheduleSnapshotContinuation: vi.fn(async () => ({ scheduled: true })),
    assertSnapshotActive: vi.fn(async () => ({
      generation: snapshot.generation,
      expiresAtMs: Date.now() + 5 * 60_000,
    })),
    prepareSnapshotManifest: vi.fn(async () => {
      manifestPublishedAtMs ??= Date.now();
      return progress();
    }),
    finishSnapshot: vi.fn(async () => ({
      generation: snapshot.generation,
      clearedDirtyDays: snapshot.dirtyDays.length,
    })),
    failSnapshot: vi.fn(async () => ({
      generation: snapshot.generation,
      retainedDirtyDays: snapshot.dirtyDays.length,
    })),
    getOutstandingSnapshotCopyIntents: vi.fn(async () => intents),
    recordSnapshotCopyIntent: vi.fn(async (input: AgentSnapshotCopyIntent) => {
      const intent = {
        generation: input.generation,
        target: input.target,
        copyAttempt: input.copyAttempt,
        startedAt: input.startedAt,
      };
      intents = [intent];
      return intent;
    }),
    attachSnapshotCopyJob: vi.fn(async (input: AgentSnapshotCopyIntent & { jobId: string }) => {
      intents = [{ ...intents[0]!, jobId: input.jobId }];
      return intents[0];
    }),
    settleSnapshotCopyIntent: vi.fn(
      async (input: AgentSnapshotCopyIntent & { jobId: string; status: 'done' | 'error' }) => {
        intents = [];
        if (input.status === 'done') nextCopyIndex += 1;
        return { removed: true };
      },
    ),
    rejectSnapshotCopyIntent: vi.fn(async () => {
      intents = [];
      return { removed: true };
    }),
    ...options.overrides,
  };
  const queueSend = vi.fn().mockResolvedValue(undefined);
  const env = {
    AGENT_DELIVERY_COORDINATOR: { getByName: vi.fn(() => coordinator) },
    AGENT_SNAPSHOT_QUEUE: { send: queueSend },
    TINYBIRD_AGENT_SNAPSHOT_TOKEN: 'snapshot-token',
    TINYBIRD_HOST: 'https://api.tinybird.test',
  } as unknown as Pick<
    AgentConsumerEnv,
    | 'AGENT_DELIVERY_COORDINATOR'
    | 'AGENT_SNAPSHOT_QUEUE'
    | 'TINYBIRD_AGENT_SNAPSHOT_TOKEN'
    | 'TINYBIRD_HOST'
  >;
  return { coordinator, env, queueSend, progress };
}

function snapshotStats(overrides: Record<string, unknown> = {}) {
  return {
    lastDeliverySequence: 5,
    lastSnapshotGeneration: 2,
    activeDeliveries: 0,
    dirtyDays: 2,
    incompleteDays: 0,
    dirtyDayLinks: 0,
    gatePhase: 'open',
    gateExpiresAtMs: null,
    capturedSnapshotDays: 0,
    activeSnapshotGeneration: null,
    activeSnapshotCopyIntents: 0,
    erasureStarted: false,
    databaseSizeBytes: 1,
    ...overrides,
  };
}
