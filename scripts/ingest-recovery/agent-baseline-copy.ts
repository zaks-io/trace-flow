import type { BaselineCopyCheckpoint } from '../../apps/agent-consumer/src/baseline-copy-contract';
import { quote } from './agent-data';
import type { AgentRecoveryClient, AgentTinybirdClient } from './agent-transport';
import { waitForMigrationCopy } from './agent-migration-runtime';

export async function runBaselineCopy(
  tb: AgentTinybirdClient,
  recovery: AgentRecoveryClient,
  category: BaselineCopyCheckpoint['category'],
  window: { startDay: string; endDay: string },
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
      const params = new URLSearchParams({
        org_id: recovery.org,
        start_day: window.startDay,
        end_day: window.endDay,
        copy_attempt: String(claimed.copyAttempt),
        _mode: 'append',
      });
      const response = await tb.request(`/v0/pipes/${pipe}/copy?${params}`, '');
      const jobId: unknown = response.job?.job_id;
      if (typeof jobId !== 'string')
        throw new Error('Baseline Copy returned no job receipt; durable intent remains unresolved');
      checkpoint = (await recovery.call('confirmBaselineCopy', {
        category,
        jobId,
        complete: false,
      })) as BaselineCopyCheckpoint;
    }
  }
  if (!checkpoint.jobId) {
    const result = await tb.sql(`SELECT job_id, status FROM tinybird.jobs_log
      WHERE job_type IN ('copy', 'copy_from_branch')
        AND JSONExtractString(job_metadata, 'pipe_name') = ${quote(pipe)}
        AND JSONExtractString(job_metadata, 'parameters', 'org_id') = ${quote(recovery.org)}
        AND JSONExtractString(job_metadata, 'parameters', 'start_day') = ${quote(window.startDay)}
        AND JSONExtractString(job_metadata, 'parameters', 'end_day') = ${quote(window.endDay)}
        AND JSONExtractString(job_metadata, 'parameters', 'copy_attempt') = ${quote(String(checkpoint.copyAttempt))}
      ORDER BY created_at DESC, job_id DESC LIMIT 2`);
    const job = result.data[0];
    if (result.data.length !== 1 || typeof job?.job_id !== 'string') {
      throw new Error(
        'Baseline Copy start outcome is unresolved; refusing to launch a duplicate job or release the deletion lock',
      );
    }
    checkpoint = (await recovery.call('confirmBaselineCopy', {
      category,
      jobId: job.job_id,
      complete: false,
    })) as BaselineCopyCheckpoint;
  }
  if (!checkpoint.jobId) throw new Error('Baseline Copy checkpoint omitted its job receipt');
  if (!checkpoint.complete) {
    await waitForMigrationCopy(tb, checkpoint.jobId);
    await recovery.call('confirmBaselineCopy', {
      category,
      jobId: checkpoint.jobId,
      complete: true,
    });
  }
  return checkpoint.jobId;
}
