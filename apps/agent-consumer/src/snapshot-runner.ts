import type { AgentConsumerEnv } from './context';
import type { AgentSnapshotProgress } from './agent-delivery-coordinator-contract';
import {
  AGENT_SNAPSHOT_RUN_DEADLINE_MS,
  AGENT_SNAPSHOT_WORK_DEADLINE_MS,
  SnapshotCapturedDaysExpiredError,
  assertSnapshotOrgId,
  assertSnapshotDaysRetained,
  beforeSnapshotDeadline,
  continueAgentSnapshot,
  isSnapshotRetryable,
  requireCurrentSnapshotIntent,
  requireSnapshotIntent,
  snapshotCopyPlans,
  waitForSnapshotJob,
} from './snapshot-runner-support';
import {
  AGENT_SNAPSHOT_TARGETS,
  discoverSnapshotCopy,
  publishSnapshotManifest,
  SnapshotCopyStartRejectedError,
  startSnapshotCopy,
  type SnapshotPlan,
} from './snapshot-tinybird';

export {
  AGENT_SNAPSHOT_POLL_INTERVAL_MS,
  AGENT_SNAPSHOT_WORK_DEADLINE_MS,
  snapshotCopyPlans,
} from './snapshot-runner-support';

export type AgentSnapshotRunResult =
  | { status: 'idle' }
  | { status: 'retry'; reason: 'gate-active' | 'deliveries-draining' }
  | { status: 'continued'; generation: number; capturedDays: number; nextCopyIndex: number }
  | { status: 'complete'; generation: number; capturedDays: number; catchupQueued: boolean };

type SnapshotRunnerEnv = Pick<
  AgentConsumerEnv,
  | 'AGENT_DELIVERY_COORDINATOR'
  | 'AGENT_SNAPSHOT_QUEUE'
  | 'TINYBIRD_AGENT_SNAPSHOT_TOKEN'
  | 'TINYBIRD_HOST'
>;

export async function runAgentSnapshot(
  env: SnapshotRunnerEnv,
  orgId: string,
): Promise<AgentSnapshotRunResult> {
  const runStartedAt = Date.now();
  const workDeadlineAt = runStartedAt + AGENT_SNAPSHOT_WORK_DEADLINE_MS;
  const hardDeadlineAt = runStartedAt + AGENT_SNAPSHOT_RUN_DEADLINE_MS;
  assertSnapshotOrgId(orgId);
  const claimId = crypto.randomUUID();
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  const initial = await beforeSnapshotDeadline(
    () => coordinator.getStats({}),
    hardDeadlineAt,
    'read coordinator',
  );

  if (initial.erasureStarted) return { status: 'idle' };
  let progress: AgentSnapshotProgress;
  if (initial.gatePhase === 'snapshot') {
    try {
      progress = await beforeSnapshotDeadline(
        () => coordinator.claimSnapshot({ claimId }),
        hardDeadlineAt,
        'claim snapshot',
      );
    } catch (error) {
      if (isSnapshotRetryable(error)) return { status: 'retry', reason: 'gate-active' };
      throw error;
    }
  } else {
    if (initial.gatePhase === 'open' && initial.dirtyDays <= initial.incompleteDays) {
      return { status: 'idle' };
    }
    let activeDeliveries = initial.activeDeliveries;
    if (initial.gatePhase === 'open') {
      const requested = await beforeSnapshotDeadline(
        () => coordinator.requestSnapshot({}),
        hardDeadlineAt,
        'request snapshot',
      );
      activeDeliveries = requested.activeDeliveries;
    }
    if (activeDeliveries > 0) return { status: 'retry', reason: 'deliveries-draining' };
    try {
      const snapshot = await beforeSnapshotDeadline(
        () => coordinator.beginSnapshot({ claimId }),
        hardDeadlineAt,
        'begin snapshot',
      );
      progress = await beforeSnapshotDeadline(
        () => coordinator.getSnapshotProgress({ generation: snapshot.generation, claimId }),
        hardDeadlineAt,
        'read snapshot progress',
      );
    } catch (error) {
      const current = await beforeSnapshotDeadline(
        () => coordinator.getStats({}),
        hardDeadlineAt,
        'recheck snapshot generation',
      );
      if (current.gatePhase === 'snapshot') return { status: 'retry', reason: 'gate-active' };
      if (current.dirtyDays <= current.incompleteDays) return { status: 'idle' };
      throw error;
    }
  }

  const plan: SnapshotPlan = {
    orgId,
    generation: progress.generation,
    dirtyDays: progress.dirtyDays,
  };
  const continueRun = (current: AgentSnapshotProgress) =>
    continueAgentSnapshot(env, coordinator, orgId, current, claimId, hardDeadlineAt);
  try {
    const copies = snapshotCopyPlans(plan);
    while (progress.nextCopyIndex < progress.totalCopies) {
      if (Date.now() >= workDeadlineAt) {
        return await continueRun(progress);
      }
      progress = await beforeSnapshotDeadline(
        () => coordinator.renewSnapshotClaim({ generation: plan.generation, claimId }),
        workDeadlineAt,
        'renew snapshot claim',
      );
      const copyIndex = progress.nextCopyIndex;
      const target = AGENT_SNAPSHOT_TARGETS[copyIndex % AGENT_SNAPSHOT_TARGETS.length];
      const copy = copies[Math.floor(copyIndex / AGENT_SNAPSHOT_TARGETS.length)];
      if (!copy || !target) throw new Error('snapshot Copy cursor exceeds its plan');
      const key = { generation: plan.generation, target, copyAttempt: copy.copyAttempt };
      const intents = await beforeSnapshotDeadline(
        () => coordinator.getOutstandingSnapshotCopyIntents({}),
        workDeadlineAt,
        'read snapshot Copy intent',
      );
      let intent = requireCurrentSnapshotIntent(intents, key);
      if (!intent) {
        await beforeSnapshotDeadline(
          () => coordinator.assertSnapshotActive({ generation: plan.generation, claimId }),
          workDeadlineAt,
          'validate snapshot before Copy',
        );
        await beforeSnapshotDeadline(
          () =>
            coordinator.recordSnapshotCopyIntent({
              ...key,
              claimId,
              copyIndex,
              startedAt: Date.now(),
            }),
          workDeadlineAt,
          `record ${target} intent`,
        );
        try {
          const jobId = await beforeSnapshotDeadline(
            () => startSnapshotCopy(env, target, copy),
            workDeadlineAt,
            `start ${target}`,
          );
          await beforeSnapshotDeadline(
            () => coordinator.attachSnapshotCopyJob({ ...key, claimId, copyIndex, jobId }),
            workDeadlineAt,
            `record ${target} job`,
          );
        } catch (error) {
          if (error instanceof SnapshotCopyStartRejectedError) {
            await beforeSnapshotDeadline(
              () => coordinator.rejectSnapshotCopyIntent({ ...key, claimId, copyIndex }),
              hardDeadlineAt,
              `reject ${target} intent`,
            );
            throw error;
          }
          progress = await coordinator.getSnapshotProgress({
            generation: plan.generation,
            claimId,
          });
          return await continueRun(progress);
        }
        const startedIntents = await coordinator.getOutstandingSnapshotCopyIntents({});
        intent = requireSnapshotIntent(startedIntents, key);
        if (!intent) throw new Error('snapshot Copy intent is missing after its start');
      }

      let jobId = intent.jobId;
      let discoveredStatus: string | undefined;
      if (!jobId) {
        const discovered = await beforeSnapshotDeadline(
          () => discoverSnapshotCopy(env, orgId, intent),
          workDeadlineAt,
          `discover ${target} job`,
        );
        if (!discovered) {
          return await continueRun(progress);
        }
        jobId = discovered.id;
        discoveredStatus = discovered.status;
        const discoveredJobId = jobId;
        await beforeSnapshotDeadline(
          () =>
            coordinator.attachSnapshotCopyJob({
              ...key,
              claimId,
              copyIndex,
              jobId: discoveredJobId,
            }),
          workDeadlineAt,
          `record discovered ${target} job`,
        );
      }
      const status =
        discoveredStatus === 'done' || discoveredStatus === 'error'
          ? discoveredStatus
          : await waitForSnapshotJob(env, orgId, intent, jobId, workDeadlineAt);
      if (status === null) return await continueRun(progress);
      const settledJobId = jobId;
      await beforeSnapshotDeadline(
        () =>
          coordinator.settleSnapshotCopyIntent({
            ...key,
            claimId,
            copyIndex,
            jobId: settledJobId,
            status,
          }),
        workDeadlineAt,
        `settle ${target} job`,
      );
      if (status === 'error') throw new Error(`Snapshot Copy job ${settledJobId} failed`);
      progress = await coordinator.getSnapshotProgress({ generation: plan.generation, claimId });
    }

    assertSnapshotDaysRetained(plan.dirtyDays, Date.now());
    progress = await beforeSnapshotDeadline(
      () => coordinator.prepareSnapshotManifest({ generation: plan.generation, claimId }),
      workDeadlineAt,
      'prepare snapshot manifest',
    );
    if (progress.manifestPublishedAtMs === undefined) {
      throw new Error('snapshot manifest timestamp is missing');
    }
    const manifestPublishedAtMs = progress.manifestPublishedAtMs;
    await beforeSnapshotDeadline(
      () =>
        publishSnapshotManifest(env, {
          ...plan,
          publishedAtMs: manifestPublishedAtMs,
        }),
      workDeadlineAt,
      'publish manifest',
    );
    await beforeSnapshotDeadline(
      () => coordinator.finishSnapshot({ generation: plan.generation, claimId }),
      hardDeadlineAt,
      'finish snapshot',
    );
  } catch (error) {
    const [latest, intents] = await Promise.all([
      coordinator.getSnapshotProgress({ generation: plan.generation, claimId }),
      coordinator.getOutstandingSnapshotCopyIntents({}),
    ]);
    if (
      !(error instanceof SnapshotCapturedDaysExpiredError) &&
      (intents.length > 0 || latest.nextCopyIndex === latest.totalCopies)
    ) {
      return await continueRun(latest);
    }
    await beforeSnapshotDeadline(
      () => coordinator.failSnapshot({ generation: plan.generation, claimId }),
      hardDeadlineAt,
      'fail snapshot',
    );
    throw error;
  }

  const final = await coordinator.getStats({});
  const catchupQueued = final.dirtyDays > final.incompleteDays;
  if (catchupQueued) {
    await env.AGENT_SNAPSHOT_QUEUE.send({ type: 'agent-snapshot', org_id: orgId });
  }
  return {
    status: 'complete',
    generation: plan.generation,
    capturedDays: plan.dirtyDays.length,
    catchupQueued,
  };
}
