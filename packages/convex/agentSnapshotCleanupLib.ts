import { agentAnalyticsDayBounds, sha256Hex } from '@trace-flow/utils';
import { fetchPipe, startDeleteRows, waitForDeleteRows } from '@trace-flow/tinybird-client';
import { AGENT_SNAPSHOT_TARGETS } from '@trace-flow/tinybird-client';

export const SNAPSHOT_READER_GRACE_MS = 10 * 60 * 1000;

interface CleanupEnv {
  TINYBIRD_HOST: string;
  TINYBIRD_AGENT_SNAPSHOT_TOKEN: string;
  TINYBIRD_AGENT_SNAPSHOT_CLEANUP_TOKEN: string;
}
interface PublishedDay {
  SnapshotDay: string;
  SnapshotGeneration: number;
  PublishedAt: string;
}

/** Only remove generations superseded by a committed pointer visible for the full reader grace. */
export async function cleanupAgentSnapshots(
  env: CleanupEnv,
  orgId: string,
  previousFingerprint: string | undefined,
  previousCleanupAt: number | undefined,
): Promise<string | null> {
  const now = Date.now();
  const { oldestDay, today } = agentAnalyticsDayBounds(now);
  const pointers = await fetchPipe<PublishedDay>({
    baseUrl: env.TINYBIRD_HOST,
    token: env.TINYBIRD_AGENT_SNAPSHOT_TOKEN,
    pipe: 'agent_snapshot_manifest_latest',
    params: { org_id: orgId, oldest_day: oldestDay, today_day: today },
    schema: {
      parse(value: unknown): PublishedDay {
        const row = value as PublishedDay;
        if (
          !row ||
          typeof row.SnapshotDay !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(row.SnapshotDay) ||
          typeof row.SnapshotGeneration !== 'number' ||
          !Number.isSafeInteger(row.SnapshotGeneration) ||
          row.SnapshotGeneration < 1 ||
          typeof row.PublishedAt !== 'string'
        ) {
          throw new Error('Invalid snapshot cleanup pointer');
        }
        return row;
      },
    },
  });
  if (
    pointers.length > 367 ||
    new Set(pointers.map((row) => row.SnapshotDay)).size !== pointers.length
  ) {
    throw new Error('Snapshot cleanup pointers exceed their bounded unique day set');
  }
  const cutoff = now - SNAPSHOT_READER_GRACE_MS;
  const eligible = pointers.filter((row) => {
    const published = Date.parse(`${row.PublishedAt.replace(' ', 'T').replace(/Z$/, '')}Z`);
    if (!Number.isFinite(published)) throw new Error('Invalid snapshot publication time');
    return published <= cutoff;
  });
  if (eligible.length === 0) return null;
  const fingerprint = await sha256Hex(
    JSON.stringify(eligible.map((row) => [row.SnapshotDay, row.SnapshotGeneration]).sort()),
  );
  if (
    fingerprint === previousFingerprint &&
    previousCleanupAt !== undefined &&
    Date.now() - previousCleanupAt < 24 * 60 * 60 * 1000
  )
    return null;
  const deadline = Date.now() + 4 * 60 * 1000;
  const jobs: string[] = [];
  const org = sqlLiteral(orgId);
  const versions = eligible
    .map(
      (row) =>
        `(SnapshotDay = '${row.SnapshotDay}' AND SnapshotGeneration < ${row.SnapshotGeneration})`,
    )
    .join(' OR ');
  for (const datasource of AGENT_SNAPSHOT_TARGETS) {
    jobs.push(
      await startDeleteRows({
        baseUrl: env.TINYBIRD_HOST,
        token: env.TINYBIRD_AGENT_SNAPSHOT_CLEANUP_TOKEN,
        datasource,
        condition: `OrgId = ${org} AND (${versions})`,
      }),
    );
  }
  const supersededDays = eligible
    .map(
      (row) =>
        `(day = toDate('${row.SnapshotDay}') AND SnapshotGeneration < ${row.SnapshotGeneration})`,
    )
    .join(' OR ');
  jobs.push(
    await startDeleteRows({
      baseUrl: env.TINYBIRD_HOST,
      token: env.TINYBIRD_AGENT_SNAPSHOT_CLEANUP_TOKEN,
      datasource: 'agent_snapshot_manifest',
      condition: `OrgId = ${org} AND notEmpty(SnapshotDays) AND arrayAll(day -> (${supersededDays}), SnapshotDays)`,
    }),
  );
  for (const jobId of jobs)
    await waitForDeleteRows(
      { baseUrl: env.TINYBIRD_HOST, token: env.TINYBIRD_AGENT_SNAPSHOT_CLEANUP_TOKEN },
      jobId,
      deadline,
    );
  return fingerprint;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}
