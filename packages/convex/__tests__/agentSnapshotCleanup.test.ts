import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupAgentSnapshots } from '../agentSnapshotCleanupLib';

const env = {
  TINYBIRD_HOST: 'https://tinybird.test',
  TINYBIRD_AGENT_SNAPSHOT_TOKEN: 'read',
  TINYBIRD_AGENT_SNAPSHOT_CLEANUP_TOKEN: 'admin',
};
const old = {
  SnapshotDay: '2026-09-10',
  SnapshotGeneration: 10,
  PublishedAt: '2026-09-13 00:00:00.000',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function transport(rows: unknown[], failJob = false) {
  const deletes: { datasource: string; condition: string }[] = [];
  const pipeParams: URLSearchParams[] = [];
  const requests: string[] = [];
  let jobs = 0;
  let activeJobs = 0;
  let maxActiveJobs = 0;
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-13T01:00:00Z'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/pipes/')) {
        pipeParams.push(url.searchParams);
        return Response.json({ data: rows });
      }
      if (url.pathname.endsWith('/delete')) {
        activeJobs++;
        maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
        requests.push(`delete:${url.pathname.split('/')[3]}`);
        deletes.push({
          datasource: url.pathname.split('/')[3]!,
          condition: new URLSearchParams(String(init?.body)).get('delete_condition')!,
        });
        return Response.json({ job_id: `job-${++jobs}` });
      }
      if (url.pathname.includes('/jobs/')) {
        const parts = url.pathname.split('/');
        requests.push(`status:${parts[parts.length - 1]}`);
        if (!failJob) activeJobs--;
        return Response.json({
          job_id: parts[parts.length - 1],
          status: failJob ? 'error' : 'done',
        });
      }
      throw new Error('Unexpected cleanup request');
    }),
  );
  return { deletes, pipeParams, requests, maxActiveJobs: () => maxActiveJobs };
}

describe('superseded snapshot cleanup', () => {
  it('deletes only superseded generations after the reader grace, keeping cross-day commits whole', async () => {
    const { deletes, pipeParams, requests, maxActiveJobs } = transport([
      old,
      { SnapshotDay: '2026-09-12', SnapshotGeneration: 12, PublishedAt: '2026-09-13 00:59:00.000' },
    ]);
    const hash = await cleanupAgentSnapshots(env, "org'quoted", undefined, undefined);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(deletes).toHaveLength(10);
    expect(Object.fromEntries(pipeParams[0]!)).toMatchObject({
      oldest_day: '2025-09-13',
      today_day: '2026-09-13',
    });
    expect(deletes[0]!.condition).toContain("OrgId = 'org\\'quoted'");
    expect(deletes[0]!.condition).toContain(
      "SnapshotDay = '2026-09-10' AND SnapshotGeneration < 10",
    );
    expect(deletes[0]!.condition).not.toContain('2026-09-12');
    expect(deletes[9]!.condition).toContain(
      "arrayAll(day -> ((day = toDate('2026-09-10') AND SnapshotGeneration < 10)), SnapshotDays)",
    );
    expect(deletes[9]!.condition).not.toContain('2026-09-12');
    expect(requests).toEqual(
      deletes.flatMap((deletion, index) => [
        `delete:${deletion.datasource}`,
        `status:job-${index + 1}`,
      ]),
    );
    expect(maxActiveJobs()).toBe(1);
  });

  it('uses each day generation so a quiet baseline day does not prevent hot-day cleanup', async () => {
    const { deletes } = transport([
      { ...old, SnapshotDay: '2026-09-01', SnapshotGeneration: 1 },
      { ...old, SnapshotDay: '2026-09-12', SnapshotGeneration: 3 },
    ]);
    await cleanupAgentSnapshots(env, 'org', undefined, undefined);
    expect(deletes[9]!.condition).toBe(
      "OrgId = 'org' AND notEmpty(SnapshotDays) AND arrayAll(day -> ((day = toDate('2026-09-01') AND SnapshotGeneration < 1) OR (day = toDate('2026-09-12') AND SnapshotGeneration < 3)), SnapshotDays)",
    );
  });

  it('skips unchanged pointers within a day and retries daily for late abandoned Copy writes', async () => {
    const { deletes } = transport([old]);
    const hash = await cleanupAgentSnapshots(env, 'org', undefined, undefined);
    deletes.length = 0;
    expect(await cleanupAgentSnapshots(env, 'org', hash!, Date.now())).toBeNull();
    expect(deletes).toHaveLength(0);
    await cleanupAgentSnapshots(env, 'org', hash!, Date.now() - 86_400_000);
    expect(deletes).toHaveLength(10);
  });

  it('does not report cleanup completion when a deletion job fails', async () => {
    const { deletes } = transport([old], true);
    await expect(cleanupAgentSnapshots(env, 'org', undefined, undefined)).rejects.toThrow(
      'deletion job failed',
    );
    expect(deletes).toHaveLength(1);
  });

  it('rejects duplicate day pointers before requesting any mutation', async () => {
    const { deletes } = transport([old, old]);
    await expect(cleanupAgentSnapshots(env, 'org', undefined, undefined)).rejects.toThrow(
      'bounded unique day set',
    );
    expect(deletes).toHaveLength(0);
  });
});
