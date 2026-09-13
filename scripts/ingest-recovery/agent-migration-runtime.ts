import { mkdtempSync, openSync, writeFileSync, closeSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AgentTinybirdClient, AgentTinybirdRequestError } from './agent-transport';

export function requiredMigrationEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing migration environment: ${name}`);
  return value;
}

export async function startMigrationRuntime() {
  const directory = mkdtempSync(join(tmpdir(), 'trace-flow-ingestion-migration-'));
  const config = join(directory, 'tinybird.json');
  writeFileSync(
    config,
    JSON.stringify({
      host: requiredMigrationEnvironment('TB_HOST'),
      token: requiredMigrationEnvironment('TB_TOKEN'),
    }),
    { mode: 0o600 },
  );
  let tb: AgentTinybirdClient;
  try {
    tb = new AgentTinybirdClient(config);
  } finally {
    unlinkSync(config);
  }
  const log = openSync(join(directory, 'bridge.log'), 'wx', 0o600);
  const port = 8798;
  const url = `http://127.0.0.1:${port}`;
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    throw new Error('Migration bridge port is already in use');
  } catch (error) {
    if (error instanceof Error && error.message === 'Migration bridge port is already in use')
      throw error;
  }
  const child = spawn(
    'bunx',
    [
      'wrangler',
      'dev',
      '--config',
      'scripts/ingest-recovery/wrangler.jsonc',
      '--env',
      'production',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--show-interactive-dev-session',
      'false',
    ],
    { stdio: ['ignore', log, log] },
  );
  const close = () => {
    child.once('exit', () => rmSync(directory, { recursive: true, force: true }));
    child.kill('SIGTERM');
    closeSync(log);
    if (child.exitCode !== null) rmSync(directory, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 90_000;
    while (true) {
      if (child.exitCode !== null)
        throw new Error(`Migration bridge failed; private diagnostic: ${directory}`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 400) break;
      } catch {
        /* Wrangler establishes its remote service bindings before listening. */
      }
      if (Date.now() >= deadline)
        throw new Error(`Migration bridge did not start; private diagnostic: ${directory}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { tb, url, directory, close };
  } catch (error) {
    close();
    throw error;
  }
}

async function cloudflare(path: string): Promise<unknown> {
  const account = requiredMigrationEnvironment('CLOUDFLARE_ACCOUNT_ID');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}${path}`,
    {
      headers: { Authorization: `Bearer ${requiredMigrationEnvironment('CLOUDFLARE_API_TOKEN')}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`Cloudflare migration check failed: HTTP ${response.status}`);
  const body = (await response.json()) as { success?: boolean; result?: unknown };
  if (body.success !== true) throw new Error('Cloudflare migration check was not successful');
  return body.result;
}

export async function requireDrainedAgentQueues(): Promise<void> {
  const queues: { queue_name: string; queue_id: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await cloudflare(`/queues?page=${page}&per_page=100`);
    if (!Array.isArray(batch)) throw new Error('Invalid Cloudflare queue listing');
    queues.push(...batch);
    if (batch.length < 100) break;
    if (page === 20) throw new Error('Cloudflare queue listing bound exceeded');
  }
  for (const name of ['agent-ingest-prod', 'agent-ingest-dlq-prod']) {
    const matches = queues.filter((queue) => queue.queue_name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${name} queue`);
    const metrics = (await cloudflare(`/queues/${matches[0]!.queue_id}/metrics`)) as {
      backlog_count?: number;
    };
    if (metrics.backlog_count !== 0) throw new Error(`${name} has not drained`);
  }
}

export async function requireAgentProducerMaintenance(): Promise<void> {
  const response = await fetch('https://collector.trace-flow.dev/v1/ingest', {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  if (
    response.status !== 503 ||
    ((await response.json()) as { error?: string }).error !== 'ingestion_maintenance'
  ) {
    throw new Error('Producer maintenance is required for full frozen ledger verification');
  }
}

export async function waitForMigrationCopy(tb: AgentTinybirdClient, jobId: string): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(jobId)) throw new Error('Invalid migration Copy job');
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    let job: { status?: unknown };
    try {
      job = await tb.request(`/v0/jobs/${jobId}`);
    } catch (error) {
      if (!(error instanceof AgentTinybirdRequestError) || error.status !== 404) throw error;
      const result = await tb.sql(
        `SELECT job_id, status FROM tinybird.jobs_log WHERE job_id = '${jobId}' LIMIT 2`,
      );
      if (result.data.length !== 1 || result.data[0]?.job_id !== jobId) {
        throw new Error('Migration Copy job is absent from both the Jobs API and jobs_log');
      }
      job = result.data[0]!;
    }
    if (job.status === 'done') return;
    if (typeof job.status !== 'string' || !['waiting', 'working'].includes(job.status)) {
      throw new Error('Migration Copy job failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Migration Copy did not finish before its deadline');
}

export async function controlPlaneMigrationOrganizations(): Promise<string[]> {
  requiredMigrationEnvironment('CONVEX_DEPLOY_KEY');
  const organizations: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const child = Bun.spawn(
      [
        'bunx',
        'convex',
        'run',
        '--prod',
        'agentIngestionMigration:listOrganizations',
        JSON.stringify({ cursor }),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(
        `Control-plane organization enumeration failed (${code}, ${diagnostic.length} diagnostic bytes)`,
      );
    const result = JSON.parse(output) as {
      organizations: string[];
      continueCursor: string;
      isDone: boolean;
    };
    if (
      !Array.isArray(result.organizations) ||
      result.organizations.some((org) => !/^[a-zA-Z0-9_-]{1,256}$/.test(org)) ||
      typeof result.isDone !== 'boolean' ||
      typeof result.continueCursor !== 'string'
    ) {
      throw new Error('Invalid control-plane organization page');
    }
    organizations.push(...result.organizations);
    if (result.isDone) return organizations;
    cursor = result.continueCursor;
  }
  throw new Error('Control-plane organization enumeration bound exceeded');
}

export async function controlPlaneMigrationLock(
  orgId: string,
  migrationId: string,
  phase: 'begin' | 'complete',
): Promise<boolean | null> {
  requiredMigrationEnvironment('CONVEX_DEPLOY_KEY');
  const child = Bun.spawn(
    [
      'bunx',
      'convex',
      'run',
      '--prod',
      `agentIngestionMigration:${phase}`,
      JSON.stringify({ orgId, migrationId }),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [output, diagnostic, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `Control-plane migration lock failed (${code}, ${diagnostic.length} diagnostic bytes)`,
    );
  const result: unknown = JSON.parse(output);
  if (
    (phase === 'begin' && typeof result !== 'boolean') ||
    (phase === 'complete' && result !== null)
  ) {
    throw new Error('Invalid control-plane migration lock response');
  }
  return result as boolean | null;
}
