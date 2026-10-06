import { captureSnapshotException, type SnapshotStage } from './snapshot-diagnostics';
import { linkSnapshotProducers } from './snapshot-tracing';
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
    if (initial.gatePhase === 'open') {
      const requested = await coordinator.requestSnapshot({});
      if (requested === null) return { status: 'retry', reason: 'gate-active' };
      activeDeliveries = requested.activeDeliveries;
    }
    if (activeDeliveries > 0) return { status: 'retry', reason: 'deliveries-draining' };
    try {
      const snapshot = await coordinator.beginSnapshot({ claimId });
      if (snapshot === null) {
        const current = await coordinator.getStats({});
        return {
          status: 'retry',
          reason: current.activeDeliveries > 0 ? 'deliveries-draining' : 'gate-active',
        };
      }
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
  const tracedProgress = await coordinator.getSnapshotProgress(
    { generation: progress.generation, claimId },
    { includeTraceLinks: true },
  );
  if ('sentryTraceHeaders' in tracedProgress && Array.isArray(tracedProgress.sentryTraceHeaders)) {
    linkSnapshotProducers(tracedProgress.sentryTraceHeaders);
  }
  const capacity = env.AGENT_SNAPSHOT_CAPACITY.getByName(SNAPSHOT_CAPACITY_NAME);
  const slot = { orgId, generation: plan.generation };
  let stage: SnapshotStage = 'acquire-capacity';
  let copyTarget: (typeof AGENT_SNAPSHOT_TARGETS)[number] | undefined;
  let copyAttempt: number | undefined;
  const continueRun = (current: AgentSnapshotProgress) => {
    stage = 'continue-snapshot';
    return continueAgentSnapshot(coordinator, orgId, current, claimId, hardDeadlineAt);
  };
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
      copyTarget = target;
      copyAttempt = copy.copyAttempt;
      const key = {
        generation: plan.generation,
        target,
        copyAttempt: copy.copyAttempt,
        claimId,
        copyIndex,
      };
      stage = 'read-copy-intent';
      const intent = requireCurrentSnapshotIntent(
        await coordinator.getOutstandingSnapshotCopyIntents({}),
        key,
      );
      if (!intent) {
        await coordinator.assertSnapshotActive({ generation: plan.generation, claimId });
        if (Date.now() >= workDeadlineAt) return await continueRun(progress);
        // The continuation alarm is already durable. Scheduling here could strand an unsubmitted intent.
        stage = 'record-copy-intent';
        await coordinator.recordSnapshotCopyIntent({ ...key, startedAt: Date.now() });
        try {
          // Once the intent exists, submit even if its persistence crossed the work deadline.
          stage = 'start-copy';
          const jobId = await startSnapshotCopy(env, target, copy);
          stage = 'attach-copy-receipt';
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
      stage = 'prepare-copy-check';
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
        stage = 'recover-copy-receipt';
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
        stage = 'attach-copy-receipt';
        await coordinator.attachSnapshotCopyJob({ ...key, jobId });
      } else {
        stage = 'read-copy-status';
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
      stage = 'settle-copy';
      await coordinator.settleSnapshotCopyIntent({ ...key, jobId, status });
      if (status === 'error') throw new Error(`Snapshot Copy job ${jobId} failed`);
      progress = await coordinator.getSnapshotProgress({
        generation: plan.generation,
        claimId,
      });
    }

    stage = 'prepare-manifest';
    copyTarget = undefined;
    copyAttempt = undefined;
    assertSnapshotDaysRetained(plan.dirtyDays, Date.now());
    const check = await coordinator.prepareSnapshotCheck({
      orgId,
      generation: plan.generation,
      claimId,
      copyIndex: progress.nextCopyIndex,
      recovery: false,
    });
    if (!check.ready) return await continueRun(progress);
    progress = await coordinator.prepareSnapshotManifest({
      generation: plan.generation,
      claimId,
    });
    if (progress.manifestPublishedAtMs === undefined)
      throw new Error('snapshot manifest timestamp is missing');
    const publishedAtMs = progress.manifestPublishedAtMs;
    stage = 'publish-manifest';
    await beforeSnapshotDeadline(
      () => publishSnapshotManifest(env, { ...plan, publishedAtMs }),
      workDeadlineAt,
      'publish manifest',
    );
    stage = 'finish-snapshot';
    await coordinator.finishSnapshot({ generation: plan.generation, claimId });
  } catch (error) {
    captureSnapshotException(error, {
      stage,
      orgId,
      generation: plan.generation,
      copyIndex: progress.nextCopyIndex,
      target: copyTarget,
      copyAttempt,
      elapsedMs: Date.now() - startedAt,
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
