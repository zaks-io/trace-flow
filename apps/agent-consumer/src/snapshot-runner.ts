import * as Sentry from '@sentry/cloudflare';
import { SNAPSHOT_CAPACITY_NAME } from './snapshot-capacity';
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
  requireCurrentSnapshotIntent,
  snapshotCopyPlans,
} from './snapshot-runner-support';
import {
  AGENT_SNAPSHOT_TARGETS,
  discoverSnapshotCopy,
  publishSnapshotManifest,
  snapshotJobStatus,
  SnapshotCopyStartRejectedError,
  startSnapshotCopy,
  type SnapshotPlan,
} from './snapshot-tinybird';

export { snapshotCopyPlans } from './snapshot-runner-support';

export type AgentSnapshotRunResult =
  | { status: 'idle' | 'scheduled' | 'blocked' }
  | { status: 'retry'; reason: 'gate-active' | 'deliveries-draining' }
  | { status: 'continued'; generation: number; capturedDays: number; nextCopyIndex: number }
  | { status: 'complete'; generation: number; capturedDays: number; catchupQueued: boolean };

type SnapshotRunnerEnv = Pick<
  AgentConsumerEnv,
  | 'AGENT_DELIVERY_COORDINATOR'
  | 'AGENT_SNAPSHOT_CAPACITY'
  | 'AGENT_SNAPSHOT_QUEUE'
  | 'TINYBIRD_AGENT_SNAPSHOT_TOKEN'
  | 'TINYBIRD_AGENT_SNAPSHOT_JOBS_TOKEN'
  | 'TINYBIRD_HOST'
>;

export async function runAgentSnapshot(
  env: SnapshotRunnerEnv,
  orgId: string,
): Promise<AgentSnapshotRunResult> {
  assertSnapshotOrgId(orgId);
  const startedAt = Date.now();
  const hardDeadlineAt = startedAt + AGENT_SNAPSHOT_RUN_DEADLINE_MS;
  const workDeadlineAt = startedAt + AGENT_SNAPSHOT_WORK_DEADLINE_MS;
  const claimId = crypto.randomUUID();
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  const initial = await coordinator.getStats({});
  if (initial.erasureStarted) return { status: 'idle' };
  const schedule = await coordinator.getSnapshotSchedule({});
  if (schedule.failure || schedule.check?.blockedReason) return { status: 'blocked' };
  if (schedule.wakeAtMs !== null && schedule.wakeAtMs > Date.now()) return { status: 'scheduled' };
  let progress: AgentSnapshotProgress;
  if (initial.gatePhase === 'snapshot') {
    const claimed = await coordinator.claimSnapshot({ claimId });
    if (claimed === null) return { status: 'retry', reason: 'gate-active' };
    progress = claimed;
  } else {
    if (initial.gatePhase === 'open' && initial.dirtyDays <= initial.incompleteDays)
      return { status: 'idle' };
    let activeDeliveries = initial.activeDeliveries;
    if (initial.gatePhase === 'open')
      activeDeliveries = (await coordinator.requestSnapshot({})).activeDeliveries;
    if (activeDeliveries > 0) return { status: 'retry', reason: 'deliveries-draining' };
    try {
      const snapshot = await coordinator.beginSnapshot({ claimId });
      progress = await coordinator.getSnapshotProgress({
        generation: snapshot.generation,
        claimId,
      });
    } catch (error) {
      const current = await coordinator.getStats({});
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
  const capacity = env.AGENT_SNAPSHOT_CAPACITY.getByName(SNAPSHOT_CAPACITY_NAME);
  const slot = { orgId, generation: plan.generation };
  const continueRun = (current: AgentSnapshotProgress) =>
    continueAgentSnapshot(coordinator, orgId, current, claimId, hardDeadlineAt);
  // The alarm survives a crash between admission, Copy start, and the next queue wake-up.
  await coordinator.scheduleSnapshotContinuation({ orgId });
  try {
    if (!(await capacity.acquire(slot))) {
      const intents = await coordinator.getOutstandingSnapshotCopyIntents({});
      if (progress.nextCopyIndex === 0 && intents.length === 0) {
        await coordinator.failSnapshot({ generation: plan.generation, claimId });
        await coordinator.scheduleSnapshotContinuation({ orgId });
        return { status: 'scheduled' };
      }
      return await continueRun(progress);
    }
    const copies = snapshotCopyPlans(plan);
    while (progress.nextCopyIndex < progress.totalCopies) {
      if (Date.now() >= workDeadlineAt) return await continueRun(progress);
      const copyIndex = progress.nextCopyIndex;
      const target = AGENT_SNAPSHOT_TARGETS[copyIndex % AGENT_SNAPSHOT_TARGETS.length];
      const copy = copies[Math.floor(copyIndex / AGENT_SNAPSHOT_TARGETS.length)];
      if (!copy || !target) throw new Error('snapshot Copy cursor exceeds its plan');
      const key = {
        generation: plan.generation,
        target,
        copyAttempt: copy.copyAttempt,
        claimId,
        copyIndex,
      };
      const intent = requireCurrentSnapshotIntent(
        await coordinator.getOutstandingSnapshotCopyIntents({}),
        key,
      );
      if (!intent) {
        await coordinator.assertSnapshotActive({ generation: plan.generation, claimId });
        await coordinator.recordSnapshotCopyIntent({ ...key, startedAt: Date.now() });
        await coordinator.scheduleSnapshotContinuation({ orgId });
        try {
          const jobId = await beforeSnapshotDeadline(
            () => startSnapshotCopy(env, target, copy),
            workDeadlineAt,
            `start ${target}`,
          );
          await coordinator.attachSnapshotCopyJob({ ...key, jobId });
        } catch (error) {
          if (error instanceof SnapshotCopyStartRejectedError)
            await coordinator.rejectSnapshotCopyIntent({ ...key, reason: error.message });
          throw error;
        }
        return await continueRun(progress);
      }

      const current = await coordinator.getSnapshotSchedule({});
      const recovery = !intent.jobId || current.check?.recoveryRequired === true;
      const check = await coordinator.prepareSnapshotCheck({
        orgId,
        generation: plan.generation,
        claimId,
        copyIndex,
        recovery,
      });
      if (!check.ready) return await continueRun(progress);
      let jobId = intent.jobId;
      let status;
      if (recovery) {
        const found = await beforeSnapshotDeadline(
          () => discoverSnapshotCopy(env, orgId, intent),
          workDeadlineAt,
          'recover snapshot Copy receipt',
        );
        if (!found) return await continueRun(progress);
        if (jobId && found.id !== jobId)
          throw new Error('Snapshot Copy recovery changed its job receipt');
        jobId = found.id;
        status = found.status;
        await coordinator.attachSnapshotCopyJob({ ...key, jobId });
      } else {
        status = await beforeSnapshotDeadline(
          () => snapshotJobStatus(env, jobId!),
          workDeadlineAt,
          'read snapshot job',
        );
        if (status === null) {
          await coordinator.requireSnapshotRecovery({ generation: plan.generation, claimId });
          return await continueRun(progress);
        }
      }
      console.info('agent_snapshot.check', {
        orgId,
        generation: plan.generation,
        copyIndex,
        recovery,
        status,
        statusChecks: check.state.statusChecks,
        recoveryChecks: check.state.recoveryChecks,
      });
      if (status !== 'done' && status !== 'error') return await continueRun(progress);
      if (!jobId) throw new Error('Terminal snapshot job has no receipt');
      await coordinator.settleSnapshotCopyIntent({ ...key, jobId, status });
      if (status === 'error') throw new Error(`Snapshot Copy job ${jobId} failed`);
      progress = await coordinator.getSnapshotProgress({ generation: plan.generation, claimId });
    }

    assertSnapshotDaysRetained(plan.dirtyDays, Date.now());
    const check = await coordinator.prepareSnapshotCheck({
      orgId,
      generation: plan.generation,
      claimId,
      copyIndex: progress.nextCopyIndex,
      recovery: false,
    });
    if (!check.ready) return await continueRun(progress);
    progress = await coordinator.prepareSnapshotManifest({ generation: plan.generation, claimId });
    if (progress.manifestPublishedAtMs === undefined)
      throw new Error('snapshot manifest timestamp is missing');
    const publishedAtMs = progress.manifestPublishedAtMs;
    await beforeSnapshotDeadline(
      () => publishSnapshotManifest(env, { ...plan, publishedAtMs }),
      workDeadlineAt,
      'publish manifest',
    );
    await coordinator.finishSnapshot({ generation: plan.generation, claimId });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { operation: 'agent_snapshot' },
      extra: { orgId, generation: plan.generation },
    });
    const failure = (await coordinator.getSnapshotSchedule({})).failure;
    if (failure?.generation === plan.generation) {
      await capacity.release(slot);
      await coordinator.scheduleSnapshotContinuation({ orgId });
      throw error;
    }
    const [latest, intents] = await Promise.all([
      coordinator.getSnapshotProgress({ generation: plan.generation, claimId }),
      coordinator.getOutstandingSnapshotCopyIntents({}),
    ]);
    if (
      !(error instanceof SnapshotCapturedDaysExpiredError) &&
      (intents.length > 0 || latest.nextCopyIndex === latest.totalCopies)
    )
      return await continueRun(latest);
    await coordinator.failSnapshot({
      generation: plan.generation,
      claimId,
      reason:
        error instanceof SnapshotCapturedDaysExpiredError
          ? 'Snapshot captured days expired before publication'
          : 'Snapshot failed before Copy completion',
    });
    await capacity.release(slot);
    await coordinator.scheduleSnapshotContinuation({ orgId });
    throw error;
  }
  await capacity.release(slot);
  const final = await coordinator.getStats({});
  const catchupQueued = final.dirtyDays > final.incompleteDays;
  if (catchupQueued) await coordinator.scheduleSnapshotContinuation({ orgId });
  const timing = await coordinator.getSnapshotSchedule({});
  console.info('agent_snapshot.published', {
    gateDurationMs: timing.startedAtMs === null ? null : Date.now() - timing.startedAtMs,
    dirtyAgeMs: timing.dirtySinceMs === null ? null : Date.now() - timing.dirtySinceMs,
    orgId,
    generation: plan.generation,
    capturedDays: plan.dirtyDays.length,
  });
  return {
    status: 'complete',
    generation: plan.generation,
    capturedDays: plan.dirtyDays.length,
    catchupQueued,
  };
}
