import { createHash } from 'node:crypto';
import type {
  BaselineCopyCheckpoint,
  BoundedBaselineCopyCheckpoint,
  LegacyBaselineCopyCheckpoint,
} from '../../apps/agent-consumer/src/baseline-copy-contract';
import { isBoundedBaselineCopy } from '../../apps/agent-consumer/src/baseline-copy-plan';
import { quote } from './agent-data';
import { preserveBaselineCopyFailure } from './agent-baseline-copy-retry-journal';
import { buildBaselineCopyPlan } from './agent-baseline-copy-plan';
import {
  intersectMigrationWindows,
  retainedMigrationWindow,
  verifyBaseline,
  type BaselineCategoryProof,
  type MigrationWindow,
} from './agent-migration-proof';
import {
  requireAgentProducerMaintenance,
  requireDrainedAgentQueues,
  waitForMigrationCopy,
} from './agent-migration-runtime';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';
import {
  preserveChunkFailure,
  requireEmptyCategoryTarget,
  requireEmptyChunkTarget,
  retainedSlice,
  verifyChunkSource,
  verifyCompletedChunkTarget,
} from './agent-bounded-baseline-proof';

interface BoundedCopyOptions {
  retryJournalRoot?: string;
}

export async function beginFreshBoundedBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  proof: BaselineCategoryProof,
  window: MigrationWindow,
): Promise<BoundedBaselineCopyCheckpoint> {
  const plan = buildBaselineCopyPlan(proof, window);
  await freshExternalGuards();
  await requireEmptyCategoryTarget(tb, recovery, proof.category);
  await freshExternalGuards();
  await requireEmptyCategoryTarget(tb, recovery, proof.category);
  return recovery.call('beginBoundedBaselineCopy', {
    category: proof.category,
    ...window,
    startedAt: Date.now(),
    plan,
  }) as Promise<BoundedBaselineCopyCheckpoint>;
}

export async function transitionFailedBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  checkpoint: LegacyBaselineCopyCheckpoint & { jobId: string },
  providerJob: Record<string, unknown>,
  proof: BaselineCategoryProof,
  options: BoundedCopyOptions,
  readFailedJob: () => Promise<Record<string, unknown> & { error: string }>,
): Promise<BoundedBaselineCopyCheckpoint> {
  if (!options.retryJournalRoot) {
    throw new Error('Bounded baseline Copy recovery requires --retry-journal <private directory>');
  }
  const plan = buildBaselineCopyPlan(proof, checkpoint);
  await freshExternalGuards();
  const job = await readFailedJob();
  const evidence = preserveBaselineCopyFailure(options.retryJournalRoot, {
    version: 1,
    orgId: recovery.org,
    checkpoint,
    observedAt: Date.now(),
    providerJob: { ...providerJob, ...job },
  });
  await freshExternalGuards();
  const freshJob = await readFailedJob();
  if (freshJob.error !== job.error) {
    throw new Error('Baseline Copy provider error changed while arming bounded recovery');
  }
  return recovery.call('beginBoundedBaselineCopy', {
    category: checkpoint.category,
    startDay: checkpoint.startDay,
    endDay: checkpoint.endDay,
    startedAt: checkpoint.startedAt,
    plan,
    legacyFailure: {
      expectedJobId: checkpoint.jobId,
      expectedCopyAttempt: checkpoint.copyAttempt,
      observedAt: evidence.observedAt,
      providerErrorSha256: evidence.providerErrorSha256,
      journalSha256: evidence.journalSha256,
    },
  }) as Promise<BoundedBaselineCopyCheckpoint>;
}

export async function runBoundedBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  checkpoint: BoundedBaselineCopyCheckpoint,
  options: BoundedCopyOptions,
): Promise<string[]> {
  if (checkpoint.complete) return checkpoint.completedJobs.map((job) => job.jobId);
  const pipe = `repair_agent_${checkpoint.category}_versions_baseline`;
  while (checkpoint.completedJobs.length < checkpoint.plan.chunks.length) {
    const chunkIndex = checkpoint.completedJobs.length;
    const chunk = checkpoint.plan.chunks[chunkIndex]!;
    if (!checkpoint.activeJob) {
      await freshExternalGuards();
      await verifyChunkSource(tb, recovery, checkpoint, chunk);
      await requireEmptyChunkTarget(tb, recovery, checkpoint, chunk);
      await freshExternalGuards();
      const copyAttempt = Date.now();
      const armed = (await recovery.call('armBoundedBaselineCopyChunk', {
        category: checkpoint.category,
        planSha256: checkpoint.plan.sha256,
        chunkIndex,
        copyAttempt,
      })) as BoundedBaselineCopyCheckpoint & { created: boolean };
      checkpoint = armed;
      if (armed.created) {
        checkpoint = await startChunk(tb, recovery, pipe, checkpoint, chunkIndex);
      }
    }
    if (!checkpoint.activeJob) throw new Error('Bounded baseline Copy omitted its active intent');
    if (!checkpoint.activeJob.jobId) {
      checkpoint = await recoverChunkReceipt(tb, recovery, pipe, checkpoint, chunkIndex);
    }
    const active = checkpoint.activeJob;
    if (!active?.jobId) throw new Error('Bounded baseline Copy omitted its job receipt');
    const received = { copyAttempt: active.copyAttempt, jobId: active.jobId };
    const terminal = await waitForMigrationCopy(tb, active.jobId);
    if (terminal.status !== 'done') {
      if (terminal.status === 'error' && options.retryJournalRoot) {
        preserveChunkFailure(options.retryJournalRoot, recovery, checkpoint, received, terminal);
      }
      throw new Error(`Bounded baseline Copy chunk reached terminal status ${terminal.status}`);
    }
    await freshExternalGuards();
    await verifyChunkSource(tb, recovery, checkpoint, chunk);
    await verifyCompletedChunkTarget(tb, recovery, checkpoint, chunk);
    await freshExternalGuards();
    checkpoint = (await recovery.call('completeBoundedBaselineCopyChunk', {
      category: checkpoint.category,
      planSha256: checkpoint.plan.sha256,
      chunkIndex,
      copyAttempt: active.copyAttempt,
      jobId: active.jobId,
    })) as BoundedBaselineCopyCheckpoint;
  }

  const retained = intersectMigrationWindows(checkpoint, retainedMigrationWindow());
  const retainedStats = checkpoint.plan.dailyStats.filter(
    (stat) => stat.day >= retained.startDay && stat.day <= retained.endDay,
  );
  const proof = {
    category: checkpoint.category,
    rows: retainedStats.reduce((sum, stat) => sum + stat.rows, 0),
    days: retainedStats.map((stat) => stat.day),
    dailyStats: retainedStats,
  };
  await verifyBaseline(tb, recovery.org, retained, proof, checkpoint);
  const proofSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        category: checkpoint.category,
        retained,
        proof,
        plan: checkpoint.plan.sha256,
      }),
    )
    .digest('hex');
  await freshExternalGuards();
  checkpoint = (await recovery.call('completeBoundedBaselineCopy', {
    category: checkpoint.category,
    planSha256: checkpoint.plan.sha256,
    proofSha256,
    completedAt: Date.now(),
  })) as BoundedBaselineCopyCheckpoint;
  return checkpoint.completedJobs.map((job) => job.jobId);
}

async function startChunk(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  pipe: string,
  checkpoint: BoundedBaselineCopyCheckpoint,
  chunkIndex: number,
): Promise<BoundedBaselineCopyCheckpoint> {
  const active = checkpoint.activeJob;
  const chunk = checkpoint.plan.chunks[chunkIndex];
  if (!active || !chunk) throw new Error('Bounded baseline Copy start state is invalid');
  const params = chunkParams(recovery, checkpoint, chunkIndex, active.copyAttempt);
  const response: unknown = await tb.request(`/v0/pipes/${pipe}/copy?${params.toString()}`, '');
  const receipt =
    response && typeof response === 'object' && 'job' in response ? response.job : null;
  const jobId =
    receipt && typeof receipt === 'object' && 'job_id' in receipt ? receipt.job_id : null;
  if (typeof jobId !== 'string') {
    throw new Error('Bounded baseline Copy returned no job receipt; intent remains unresolved');
  }
  return recovery.call('confirmBoundedBaselineCopyChunk', {
    category: checkpoint.category,
    planSha256: checkpoint.plan.sha256,
    chunkIndex,
    copyAttempt: active.copyAttempt,
    jobId,
  }) as Promise<BoundedBaselineCopyCheckpoint>;
}

async function recoverChunkReceipt(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  pipe: string,
  checkpoint: BoundedBaselineCopyCheckpoint,
  chunkIndex: number,
): Promise<BoundedBaselineCopyCheckpoint> {
  const active = checkpoint.activeJob;
  const chunk = checkpoint.plan.chunks[chunkIndex];
  if (!active || !chunk) throw new Error('Bounded baseline Copy receipt state is invalid');
  const result = await tb.sql(`SELECT job_id,status FROM tinybird.jobs_log
    WHERE job_type IN ('copy','copy_from_branch')
      AND JSONExtractString(job_metadata,'pipe_name')=${quote(pipe)}
      AND JSONExtractString(job_metadata,'parameters','org_id')=${quote(recovery.org)}
      AND JSONExtractString(job_metadata,'parameters','start_day')=${quote(checkpoint.startDay)}
      AND JSONExtractString(job_metadata,'parameters','end_day')=${quote(checkpoint.endDay)}
      AND JSONExtractString(job_metadata,'parameters','chunk_start_day')>=${quote(chunk.startDay)}
      AND JSONExtractString(job_metadata,'parameters','chunk_end_day')<=${quote(chunk.endDay)}
      AND JSONExtractString(job_metadata,'parameters','copy_attempt')=${quote(String(active.copyAttempt))}
      AND JSONExtractString(job_metadata,'parameters','_mode')='append'
    ORDER BY created_at DESC,job_id DESC LIMIT 2`);
  const job = result.data[0];
  if (result.data.length !== 1 || typeof job?.job_id !== 'string') {
    throw new Error(
      'Bounded baseline Copy start outcome is unresolved; duplicate submission refused',
    );
  }
  return recovery.call('confirmBoundedBaselineCopyChunk', {
    category: checkpoint.category,
    planSha256: checkpoint.plan.sha256,
    chunkIndex,
    copyAttempt: active.copyAttempt,
    jobId: job.job_id,
  }) as Promise<BoundedBaselineCopyCheckpoint>;
}

function chunkParams(
  recovery: AgentRecoveryClient,
  checkpoint: BoundedBaselineCopyCheckpoint,
  chunkIndex: number,
  copyAttempt: number,
): URLSearchParams {
  const chunk = checkpoint.plan.chunks[chunkIndex]!;
  // Retention rolls forward at UTC midnight while a long run is in flight. The proofs only cover
  // the retained slice of a chunk, so the Copy must never append days those proofs no longer see.
  const retained = retainedSlice(chunk, retainedMigrationWindow());
  if (!retained) {
    throw new Error(
      'Bounded baseline Copy chunk is fully outside analytics retention; replan before resuming',
    );
  }
  return new URLSearchParams({
    org_id: recovery.org,
    start_day: checkpoint.startDay,
    end_day: checkpoint.endDay,
    chunk_start_day: retained.startDay,
    chunk_end_day: retained.endDay,
    copy_attempt: String(copyAttempt),
    _mode: 'append',
  });
}

async function freshExternalGuards(): Promise<void> {
  await requireAgentProducerMaintenance();
  await requireDrainedAgentQueues();
}
