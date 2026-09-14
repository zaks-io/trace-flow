import type {
  BaselineCopyCheckpoint,
  LegacyBaselineCopyCheckpoint,
} from '../../apps/agent-consumer/src/baseline-copy-contract';
import { isBoundedBaselineCopy } from '../../apps/agent-consumer/src/baseline-copy-plan';
import { FACT_VERSION_DATASOURCES } from '../../apps/agent-consumer/src/delivery-write';
import { quote } from './agent-data';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';
import { waitForMigrationCopy } from './agent-migration-runtime';
import type { BaselineCategoryProof } from './agent-migration-proof';
import {
  beginFreshBoundedBaselineCopy,
  runBoundedBaselineCopy,
  transitionFailedBaselineCopy,
} from './agent-bounded-baseline-copy';

interface BaselineCopyOptions {
  retryJournalRoot?: string;
  sourceProof?: BaselineCategoryProof;
}

export async function runBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  category: BaselineCopyCheckpoint['category'],
  window: { startDay: string; endDay: string },
  options: BaselineCopyOptions = {},
): Promise<string[]> {
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
  if (checkpoint && isBoundedBaselineCopy(checkpoint)) {
    return runBoundedBaselineCopy(tb, recovery, checkpoint, options);
  }
  if (!checkpoint) {
    const proof = requireSourceProof(options.sourceProof, category);
    const bounded = await beginFreshBoundedBaselineCopy(tb, recovery, proof, window);
    return runBoundedBaselineCopy(tb, recovery, bounded, options);
  }
  const existing = checkpoint as LegacyBaselineCopyCheckpoint;
  if (existing.complete) {
    if (!existing.jobId) throw new Error('Completed baseline Copy omitted its job receipt');
    return [existing.jobId];
  }
  let legacy = existing;
  while (true) {
    if (!legacy.jobId) legacy = await recoverBaselineCopyReceipt(tb, recovery, pipe, legacy);
    if (!legacy.jobId) throw new Error('Baseline Copy checkpoint omitted its job receipt');
    if (legacy.complete) return [legacy.jobId];
    const jobId = legacy.jobId;

    const terminal = await waitForMigrationCopy(tb, jobId);
    if (terminal.status === 'done') {
      legacy = (await recovery.call('confirmBaselineCopy', {
        category,
        copyAttempt: legacy.copyAttempt,
        jobId,
        complete: true,
      })) as LegacyBaselineCopyCheckpoint;
      return [legacy.jobId!];
    }
    if (terminal.status !== 'error') {
      throw new Error(
        `Baseline Copy job reached terminal status ${terminal.status}; retry refused`,
      );
    }
    const proof = requireSourceProof(options.sourceProof, category);
    const bounded = await transitionFailedBaselineCopy(
      tb,
      recovery,
      { ...legacy, jobId },
      terminal,
      proof,
      options,
      () => readFailedBaselineCopy(tb, recovery, pipe, { ...legacy, jobId }),
    );
    return runBoundedBaselineCopy(tb, recovery, bounded, options);
  }
}

async function recoverBaselineCopyReceipt(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  pipe: string,
  checkpoint: LegacyBaselineCopyCheckpoint,
): Promise<LegacyBaselineCopyCheckpoint> {
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
  }) as Promise<LegacyBaselineCopyCheckpoint>;
}

export async function readFailedBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  pipe: string,
  checkpoint: LegacyBaselineCopyCheckpoint & { jobId: string },
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

function requireSourceProof(
  proof: BaselineCategoryProof | undefined,
  category: BaselineCopyCheckpoint['category'],
): BaselineCategoryProof {
  if (!proof || proof.category !== category || proof.rows <= 0) {
    throw new Error('Bounded baseline Copy requires an exact source plan');
  }
  return proof;
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
