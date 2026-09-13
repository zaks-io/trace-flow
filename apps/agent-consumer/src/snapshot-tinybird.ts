import { fetchPipe, insertRows } from '@trace-flow/tinybird-client';
import { readBodyWithLimit } from '@trace-flow/utils';
import {
  AGENT_SNAPSHOT_COPY_ATTEMPT_MULTIPLIER,
  isAgentSnapshotCopyAttempt,
  MAX_AGENT_SNAPSHOT_COPY_CHUNKS,
} from './agent-delivery-coordinator-contract';
import { toClickhouseDateTime64 } from './rows';
import type { AgentSnapshotCopyIntent } from './agent-ingestion-erasure';

export { AGENT_SNAPSHOT_TARGETS } from '@trace-flow/tinybird-client';
import type { AGENT_SNAPSHOT_TARGETS } from '@trace-flow/tinybird-client';

export interface SnapshotTinybirdEnv {
  TINYBIRD_HOST: string;
  TINYBIRD_AGENT_SNAPSHOT_TOKEN: string;
}

export interface SnapshotPlan {
  orgId: string;
  generation: number;
  dirtyDays: string[];
}

export interface SnapshotCopyPlan extends SnapshotPlan {
  copyAttempt: number;
}

export interface SnapshotManifestPlan extends SnapshotPlan {
  publishedAtMs: number;
}

export type SnapshotJobStatus = 'waiting' | 'working' | 'done' | 'error';

export class SnapshotCopyStartRejectedError extends Error {
  constructor(status: number) {
    super(`Snapshot Copy start failed: HTTP ${status}`);
    this.name = 'SnapshotCopyStartRejectedError';
  }
}

export function snapshotCopyAttempt(generation: number, chunkIndex?: number): number {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('snapshot generation must be a positive safe integer');
  }
  if (chunkIndex === undefined) return generation;
  if (
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= MAX_AGENT_SNAPSHOT_COPY_CHUNKS
  ) {
    throw new Error('snapshot Copy chunk index is out of range');
  }
  const copyAttempt = generation * AGENT_SNAPSHOT_COPY_ATTEMPT_MULTIPLIER + chunkIndex;
  if (!Number.isSafeInteger(copyAttempt)) {
    throw new Error('snapshot CopyAttempt exceeds the safe integer range');
  }
  return copyAttempt;
}

/** Every start has a durable intent so an uncertain response can be reconciled through jobs_log. */
export async function startSnapshotCopy(
  env: SnapshotTinybirdEnv,
  target: (typeof AGENT_SNAPSHOT_TARGETS)[number],
  plan: SnapshotCopyPlan,
): Promise<string> {
  if (!isAgentSnapshotCopyAttempt(plan.generation, plan.copyAttempt)) {
    throw new Error('snapshot CopyAttempt does not match its generation');
  }
  const url = new URL(`/v0/pipes/repair_${target}/copy`, env.TINYBIRD_HOST);
  url.search = new URLSearchParams({
    org_id: plan.orgId,
    snapshot_days: plan.dirtyDays.join(','),
    snapshot_generation: String(plan.generation),
    copy_attempt: String(plan.copyAttempt),
    _mode: 'append',
  }).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TINYBIRD_AGENT_SNAPSHOT_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      throw new SnapshotCopyStartRejectedError(response.status);
    }
    throw new Error(`Snapshot Copy start outcome is unknown: HTTP ${response.status}`);
  }
  const body = JSON.parse(
    new TextDecoder().decode(await readBodyWithLimit(response.body, 256 * 1024)),
  ) as {
    job?: { job_id?: unknown };
  };
  if (typeof body.job?.job_id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(body.job.job_id)) {
    throw new Error('Snapshot Copy start has no valid job receipt');
  }
  return body.job.job_id;
}

export async function discoverSnapshotCopy(
  env: SnapshotTinybirdEnv,
  orgId: string,
  intent: AgentSnapshotCopyIntent,
): Promise<{ id: string; status: SnapshotJobStatus } | null> {
  const jobs = await fetchPipe<{ job_id: string; status: string }>({
    baseUrl: env.TINYBIRD_HOST,
    token: env.TINYBIRD_AGENT_SNAPSHOT_TOKEN,
    pipe: 'agent_snapshot_copy_intent_jobs',
    params: {
      org_id: orgId,
      generation: intent.generation,
      target: intent.target,
      copy_attempt: intent.copyAttempt,
      started_at_ms: intent.startedAt,
    },
  });
  if (jobs.length === 0) return null;
  const job = jobs[0];
  if (
    jobs.length !== 1 ||
    !job ||
    typeof job.job_id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(job.job_id) ||
    !['waiting', 'working', 'done', 'error'].includes(job.status) ||
    (intent.jobId !== undefined && intent.jobId !== job.job_id)
  ) {
    throw new Error('Snapshot Copy discovery did not match its durable intent');
  }
  return { id: job.job_id, status: job.status as SnapshotJobStatus };
}

export async function snapshotJobStatus(
  env: SnapshotTinybirdEnv,
  jobId: string,
): Promise<SnapshotJobStatus | null> {
  const rows = await fetchPipe<{ id: string; status: SnapshotJobStatus }>({
    baseUrl: env.TINYBIRD_HOST,
    token: env.TINYBIRD_AGENT_SNAPSHOT_TOKEN,
    pipe: 'agent_snapshot_job',
    params: { job_id: jobId },
    schema: {
      parse(value: unknown) {
        const row = value as { id: string; status: string };
        if (row?.id !== jobId || !['waiting', 'working', 'done', 'error'].includes(row.status)) {
          throw new Error('Invalid snapshot job status');
        }
        return row as { id: string; status: SnapshotJobStatus };
      },
    },
  });
  if (rows.length > 1) throw new Error('Conflicting snapshot job statuses');
  return rows[0]?.status ?? null;
}

export async function publishSnapshotManifest(
  env: SnapshotTinybirdEnv,
  plan: SnapshotManifestPlan,
): Promise<void> {
  await insertRows(
    [
      {
        OrgId: plan.orgId,
        SnapshotGeneration: plan.generation,
        SnapshotDays: plan.dirtyDays,
        PublishedAt: toClickhouseDateTime64(plan.publishedAtMs),
      },
    ],
    env.TINYBIRD_AGENT_SNAPSHOT_TOKEN,
    'agent_snapshot_manifest',
    env.TINYBIRD_HOST,
  );
}
