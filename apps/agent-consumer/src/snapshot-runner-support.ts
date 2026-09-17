import type { AgentConsumerEnv } from './context';
import { agentAnalyticsDayBounds } from '@trace-flow/utils';
import {
  MAX_AGENT_SNAPSHOT_COPY_CHUNKS,
  MAX_AGENT_SNAPSHOT_COPY_DAYS,
  type AgentSnapshotProgress,
} from './agent-delivery-coordinator-contract';
import type { AgentSnapshotCopyIntent } from './agent-ingestion-erasure';
import {
  discoverSnapshotCopy,
  snapshotCopyAttempt,
  snapshotJobStatus,
  type SnapshotCopyPlan,
  type SnapshotPlan,
} from './snapshot-tinybird';

export const AGENT_SNAPSHOT_POLL_INTERVAL_MS = 2_000;
export const AGENT_SNAPSHOT_RUN_DEADLINE_MS = 4 * 60 * 1_000;
export const AGENT_SNAPSHOT_WORK_DEADLINE_MS = 3.5 * 60 * 1_000;

export class SnapshotCapturedDaysExpiredError extends Error {
  constructor() {
    super('snapshot captured days crossed the analytics retention boundary');
    this.name = 'SnapshotCapturedDaysExpiredError';
  }
}

type SnapshotTinybirdEnv = Pick<
  AgentConsumerEnv,
  'TINYBIRD_AGENT_SNAPSHOT_TOKEN' | 'TINYBIRD_HOST'
>;
type SnapshotContinuationEnv = Pick<
  AgentConsumerEnv,
  'AGENT_DELIVERY_COORDINATOR' | 'AGENT_SNAPSHOT_QUEUE'
>;
type SnapshotCoordinator = ReturnType<
  SnapshotContinuationEnv['AGENT_DELIVERY_COORDINATOR']['getByName']
>;

export async function continueAgentSnapshot(
  env: SnapshotContinuationEnv,
  coordinator: SnapshotCoordinator,
  orgId: string,
  progress: AgentSnapshotProgress,
  claimId: string,
  deadlineAt: number,
) {
  await beforeSnapshotDeadline(
    () => coordinator.scheduleSnapshotContinuation({ orgId }),
    deadlineAt,
    'schedule snapshot recovery alarm',
  );
  await beforeSnapshotDeadline(
    () => coordinator.releaseSnapshotClaim({ generation: progress.generation, claimId }),
    deadlineAt,
    'release snapshot claim',
  );
  await beforeSnapshotDeadline(
    () => env.AGENT_SNAPSHOT_QUEUE.send({ type: 'agent-snapshot', org_id: orgId }),
    deadlineAt,
    'queue continuation',
  );
  return {
    status: 'continued' as const,
    generation: progress.generation,
    capturedDays: progress.dirtyDays.length,
    nextCopyIndex: progress.nextCopyIndex,
  };
}

export function snapshotCopyPlans(plan: SnapshotPlan): SnapshotCopyPlan[] {
  if (plan.dirtyDays.length <= MAX_AGENT_SNAPSHOT_COPY_DAYS) {
    return [{ ...plan, copyAttempt: snapshotCopyAttempt(plan.generation) }];
  }
  const copies: SnapshotCopyPlan[] = [];
  for (let offset = 0; offset < plan.dirtyDays.length; offset += MAX_AGENT_SNAPSHOT_COPY_DAYS) {
    const chunkIndex = copies.length;
    if (chunkIndex >= MAX_AGENT_SNAPSHOT_COPY_CHUNKS) {
      throw new Error('snapshot has too many Copy chunks');
    }
    copies.push({
      ...plan,
      dirtyDays: plan.dirtyDays.slice(offset, offset + MAX_AGENT_SNAPSHOT_COPY_DAYS),
      copyAttempt: snapshotCopyAttempt(plan.generation, chunkIndex),
    });
  }
  return copies;
}

export function assertSnapshotDaysRetained(dirtyDays: string[], now: number): void {
  const { oldestDay, today } = agentAnalyticsDayBounds(now);
  if (dirtyDays.some((day) => day < oldestDay || day > today)) {
    throw new SnapshotCapturedDaysExpiredError();
  }
}

export async function waitForSnapshotJob(
  env: SnapshotTinybirdEnv,
  orgId: string,
  intent: AgentSnapshotCopyIntent,
  jobId: string,
  deadlineAt: number,
): Promise<'done' | 'error' | null> {
  while (Date.now() < deadlineAt) {
    let status = await beforeSnapshotDeadline(
      () => snapshotJobStatus(env, jobId),
      deadlineAt,
      'poll snapshot job',
    );
    if (status === null) {
      const discovered = await beforeSnapshotDeadline(
        () => discoverSnapshotCopy(env, orgId, intent),
        deadlineAt,
        `rediscover ${intent.target} job`,
      );
      if (discovered && discovered.id !== jobId) {
        throw new Error('Snapshot Copy discovery changed its attached job receipt');
      }
      // jobs_log trails an accepted Copy start, so a receipt with no row yet is still running.
      status = discovered?.status ?? null;
    }
    if (status === 'done' || status === 'error') return status;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return null;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(AGENT_SNAPSHOT_POLL_INTERVAL_MS, remainingMs)),
    );
  }
  return null;
}

export function requireCurrentSnapshotIntent(
  intents: AgentSnapshotCopyIntent[],
  key: { generation: number; target: string; copyAttempt: number },
): AgentSnapshotCopyIntent | null {
  if (intents.length > 1) throw new Error('snapshot has conflicting outstanding Copy intents');
  const intent = intents[0];
  if (!intent) return null;
  if (!matchesSnapshotIntent(intent, key)) {
    throw new Error('snapshot Copy intent does not match its cursor');
  }
  return intent;
}

export function requireSnapshotIntent(
  intents: AgentSnapshotCopyIntent[],
  key: { generation: number; target: string; copyAttempt: number },
): AgentSnapshotCopyIntent | null {
  return intents.find((intent) => matchesSnapshotIntent(intent, key)) ?? null;
}

export async function beforeSnapshotDeadline<T>(
  start: () => Promise<T>,
  deadlineAt: number,
  operation: string,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(`Snapshot deadline reached before ${operation}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Snapshot deadline reached during ${operation}`)),
      remainingMs,
    );
  });
  try {
    return await Promise.race([start(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function assertSnapshotOrgId(orgId: string): void {
  if (!orgId || orgId.length > 256 || orgId.includes(':')) {
    throw new Error('Invalid snapshot organization');
  }
}

function matchesSnapshotIntent(
  intent: AgentSnapshotCopyIntent,
  key: { generation: number; target: string; copyAttempt: number },
): boolean {
  return (
    intent.generation === key.generation &&
    intent.target === key.target &&
    intent.copyAttempt === key.copyAttempt
  );
}
