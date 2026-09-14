import type { BaselineCopyCheckpoint } from '../../apps/agent-consumer/src/baseline-copy-contract';
import { FACT_VERSION_DATASOURCES } from '../../apps/agent-consumer/src/delivery-write';
import { quote } from './agent-data';
import { preserveBaselineCopyFailure } from './agent-baseline-copy-retry-journal';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';
import {
  requireAgentProducerMaintenance,
  requireDrainedAgentQueues,
  waitForMigrationCopy,
} from './agent-migration-runtime';

export async function runBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  category: BaselineCopyCheckpoint['category'],
  window: { startDay: string; endDay: string },
  options: { retryJournalRoot?: string } = {},
): Promise<string> {
  const pipe = `repair_agent_${category}_versions_baseline`;
  let checkpoint = (await recovery.call('getBaselineCopy', {
    category,
  })) as BaselineCopyCheckpoint | null;
  if (
    checkpoint &&
    (checkpoint.startDay !== window.startDay || checkpoint.endDay !== window.endDay)
  ) {
    throw new Error(
      'Baseline Copy retention window changed; existing intent must be reconciled before resuming',
    );
  }
  if (!checkpoint) {
    const startedAt = Date.now();
    const claimed = (await recovery.call('beginBaselineCopy', {
      category,
      ...window,
      startedAt,
      copyAttempt: startedAt,
    })) as BaselineCopyCheckpoint & { created: boolean };
    checkpoint = claimed;
    if (claimed.created) {
      checkpoint = await startBaselineCopy(tb, recovery, pipe, claimed, false);
    }
  }
  while (true) {
    if (!checkpoint.jobId)
      checkpoint = await recoverBaselineCopyReceipt(tb, recovery, pipe, checkpoint);
    if (!checkpoint.jobId) throw new Error('Baseline Copy checkpoint omitted its job receipt');
    if (checkpoint.complete) return checkpoint.jobId;
    const jobId = checkpoint.jobId;

    const terminal = await waitForMigrationCopy(tb, jobId);
    if (terminal.status === 'done') {
      checkpoint = (await recovery.call('confirmBaselineCopy', {
        category,
        copyAttempt: checkpoint.copyAttempt,
        jobId,
        complete: true,
      })) as BaselineCopyCheckpoint;
      return checkpoint.jobId!;
    }
    if (terminal.status !== 'error') {
      throw new Error(
        `Baseline Copy job reached terminal status ${terminal.status}; retry refused`,
      );
    }
    if (checkpoint.failedAttempt) {
      throw new Error('Baseline Copy dedicated-compute retry failed; retry limit reached');
    }
    checkpoint = await armBaselineCopyRetry(
      tb,
      recovery,
      pipe,
      { ...checkpoint, jobId },
      terminal,
      options.retryJournalRoot,
    );
    checkpoint = await startBaselineCopy(tb, recovery, pipe, checkpoint, true);
  }
}

async function startBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  pipe: string,
  checkpoint: BaselineCopyCheckpoint,
  onDemandCompute: boolean,
): Promise<BaselineCopyCheckpoint> {
  const params = new URLSearchParams({
    org_id: recovery.org,
    start_day: checkpoint.startDay,
    end_day: checkpoint.endDay,
    copy_attempt: String(checkpoint.copyAttempt),
    _mode: 'append',
  });
  if (onDemandCompute) params.set('on_demand_compute', 'true');
  const response: unknown = await tb.request(`/v0/pipes/${pipe}/copy?${params.toString()}`, '');
  const receipt =
    response && typeof response === 'object' && 'job' in response ? response.job : null;
  const jobId: unknown =
    receipt && typeof receipt === 'object' && 'job_id' in receipt ? receipt.job_id : null;
  if (typeof jobId !== 'string') {
    throw new Error('Baseline Copy returned no job receipt; durable intent remains unresolved');
  }
  return recovery.call('confirmBaselineCopy', {
    category: checkpoint.category,
    copyAttempt: checkpoint.copyAttempt,
    jobId,
    complete: false,
  }) as Promise<BaselineCopyCheckpoint>;
}

async function recoverBaselineCopyReceipt(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  pipe: string,
  checkpoint: BaselineCopyCheckpoint,
): Promise<BaselineCopyCheckpoint> {
  const result = await tb.sql(`SELECT job_id, status FROM tinybird.jobs_log
    WHERE job_type IN ('copy', 'copy_from_branch')
      AND JSONExtractString(job_metadata, 'pipe_name') = ${quote(pipe)}
      AND JSONExtractString(job_metadata, 'parameters', 'org_id') = ${quote(recovery.org)}
      AND JSONExtractString(job_metadata, 'parameters', 'start_day') = ${quote(checkpoint.startDay)}
      AND JSONExtractString(job_metadata, 'parameters', 'end_day') = ${quote(checkpoint.endDay)}
      AND JSONExtractString(job_metadata, 'parameters', 'copy_attempt') = ${quote(String(checkpoint.copyAttempt))}
    ORDER BY created_at DESC, job_id DESC LIMIT 2`);
  const job = result.data[0];
  if (result.data.length !== 1 || typeof job?.job_id !== 'string') {
    throw new Error(
      'Baseline Copy start outcome is unresolved; refusing to launch a duplicate job or release the deletion lock',
    );
  }
  return recovery.call('confirmBaselineCopy', {
    category: checkpoint.category,
    copyAttempt: checkpoint.copyAttempt,
    jobId: job.job_id,
    complete: false,
  }) as Promise<BaselineCopyCheckpoint>;
}

async function armBaselineCopyRetry(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  pipe: string,
  checkpoint: BaselineCopyCheckpoint & { jobId: string },
  providerJob: Record<string, unknown>,
  retryJournalRoot: string | undefined,
): Promise<BaselineCopyCheckpoint> {
  if (!retryJournalRoot) {
    throw new Error('Baseline Copy retry requires --retry-journal <private directory>');
  }
  await requireAgentProducerMaintenance();
  await requireDrainedAgentQueues();
  const job = await readFailedBaselineCopy(tb, recovery, pipe, checkpoint);

  const observedAt = Date.now();
  const evidence = preserveBaselineCopyFailure(retryJournalRoot, {
    version: 1,
    orgId: recovery.org,
    checkpoint,
    observedAt,
    providerJob: { ...providerJob, ...job },
  });
  await requireAgentProducerMaintenance();
  await requireDrainedAgentQueues();
  const freshJob = await readFailedBaselineCopy(tb, recovery, pipe, checkpoint);
  if (freshJob.error !== job.error) {
    throw new Error('Baseline Copy provider error changed while arming its retry');
  }
  const nextCopyAttempt = Math.max(Date.now(), checkpoint.copyAttempt + 1);
  return recovery.call('retryBaselineCopy', {
    category: checkpoint.category,
    expectedJobId: checkpoint.jobId,
    expectedCopyAttempt: checkpoint.copyAttempt,
    nextCopyAttempt,
    observedAt: evidence.observedAt,
    providerErrorSha256: evidence.providerErrorSha256,
    journalSha256: evidence.journalSha256,
  }) as Promise<BaselineCopyCheckpoint>;
}

async function readFailedBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  pipe: string,
  checkpoint: BaselineCopyCheckpoint & { jobId: string },
): Promise<Record<string, unknown> & { error: string }> {
  const target = FACT_VERSION_DATASOURCES[checkpoint.category];
  const proof = (
    await tb.sql(`SELECT
      job_id,
      status,
      job_type,
      error,
      job_metadata,
      toUInt64((SELECT count() FROM ${target} FINAL WHERE OrgId = ${quote(recovery.org)})) AS target_rows
    FROM tinybird.jobs_log
    WHERE job_id = ${quote(checkpoint.jobId)}
    LIMIT 2`)
  ).data;
  const job = proof[0];
  const metadata = parseJobMetadata(job?.job_metadata);
  const parameters = metadata?.parameters;
  if (
    proof.length !== 1 ||
    job?.job_id !== checkpoint.jobId ||
    job.status !== 'error' ||
    job.job_type !== 'copy' ||
    metadata?.pipe_name !== pipe ||
    parameters?.org_id !== recovery.org ||
    parameters.start_day !== checkpoint.startDay ||
    parameters.end_day !== checkpoint.endDay ||
    parameters.copy_attempt !== String(checkpoint.copyAttempt) ||
    parameters._mode !== 'append'
  ) {
    throw new Error('Baseline Copy failed-job proof does not match its durable intent');
  }
  if (strictCount(job.target_rows, 'baseline target rows') !== 0) {
    throw new Error('Baseline Copy retry requires an empty organization category target');
  }
  if (typeof job.error !== 'string' || !job.error) {
    throw new Error('Baseline Copy failed-job proof omitted the provider error');
  }
  return { ...job, metadata, error: job.error };
}

type BaselineCopyJobMetadata = Record<string, unknown> & {
  parameters: Record<string, unknown>;
};

function parseJobMetadata(value: unknown): BaselineCopyJobMetadata | null {
  if (typeof value !== 'string') return null;
  try {
    const metadata: unknown = JSON.parse(value);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const parameters = (metadata as Record<string, unknown>).parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
    return metadata as BaselineCopyJobMetadata;
  } catch {
    return null;
  }
}

function strictCount(value: unknown, label: string): number {
  if (
    !(
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^\d+$/.test(value))
    )
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${label}`);
  return count;
}
