// Seeds the local stack's Tinybird Local with the committed fixtures, rewritten so
// they belong to one signed-in user's org and end about an hour ago.
//
// Spans are scoped by API-key analytics id and agent facts by OrgId, so the
// fixtures' placeholder owners must be replaced before the dashboard shows them.
// Run through `scripts/dev/local-stack.sh seed [email]`; seeding twice adds rows again.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = requireEnv('TRACE_FLOW_ROOT');
const convexCliDir = requireEnv('STACK_CONVEX_CLI_DIR');
const tinybirdHost = requireEnv('TRACE_FLOW_TINYBIRD_HOST');
const tinybirdToken = requireEnv('TINYBIRD_WORKSPACE_TOKEN');
const email = (process.argv[2] ?? requireEnv('STACK_EMAIL')).toLowerCase();

const NS_PER_MS = 1_000_000n;
const SPAN_TIME_FIELDS = ['ReceivedAt', 'Timestamp'];
const FACT_TIME_FIELDS = ['EventAt', 'IngestedAt', 'VendorStartedAt', 'DecidedAt'];
const NEWEST_ROW_AGE_MS = 60 * 60 * 1000;

const user = convexJsonl(['data', 'users', '--format', 'jsonl', '--limit', '10000']).find(
  (row) => row.email === email,
);
if (!user?.orgId) {
  fail(
    `no user with an org for ${email}; sign in first with: scripts/dev/local-stack.sh login-url ${email}`,
  );
}
const apiKeys = convexJson(['run', 'apiKeys:listByOrgId', JSON.stringify({ orgId: user.orgId })]);
if (apiKeys.length === 0)
  fail(`org ${user.orgId} has no API keys; finish onboarding in the web app first`);
const analyticsKey = `sha256:${createHash('sha256').update(apiKeys[0].key).digest('hex')}`;

const fixturesDir = join(root, 'fixtures');
const fixtures = readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.ndjson'))
  .map((file) => ({
    datasource: file.replace(/\.ndjson$/, ''),
    rows: readFileSync(join(fixturesDir, file), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line, preserveLargeIntegers)),
  }));

// One offset per family keeps related rows (a session's messages, tools, and
// files) in the same relative order.
const spanShiftNs = BigInt(Date.now() - NEWEST_ROW_AGE_MS) * NS_PER_MS - newestSpanNs();
const factShiftMs = Date.now() - NEWEST_ROW_AGE_MS - newestFactMs();

for (const { datasource, rows } of fixtures) {
  const body = rows.map((row) => JSON.stringify(rewrite(row), emitLargeIntegers)).join('\n');
  const response = await fetch(`${tinybirdHost}/v0/events?name=${datasource}&wait=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tinybirdToken}`, 'Content-Type': 'application/x-ndjson' },
    body,
  });
  const result = await response.text();
  if (!response.ok) fail(`${datasource}: ${response.status} ${result}`);
  const { successful_rows: ok = 0, quarantined_rows: quarantined = 0 } = JSON.parse(result);
  console.log(
    `[local-stack-seed] ${datasource}: ${ok} rows${quarantined ? `, ${quarantined} QUARANTINED` : ''}`,
  );
}
await publishAgentSnapshots();
console.log(`[local-stack-seed] seeded org ${user.orgId} for ${email}`);

// Agent pages read published snapshots, not raw facts. The agent-consumer
// snapshot runner normally builds them after ingest; replay its two steps here:
// run every snapshot Copy Pipe for the seeded days, then publish a manifest row.
async function publishAgentSnapshots() {
  const days = new Set();
  for (const { datasource, rows } of fixtures) {
    if (!datasource.startsWith('agent_')) continue;
    for (const row of rows) {
      if (row.EventAt)
        days.add(formatClickHouseTime(parseClickHouseTime(row.EventAt) + factShiftMs).slice(0, 10));
    }
  }
  const snapshotDays = [...days].sort();
  const generation = Date.now();
  const targets = readdirSync(join(root, 'copies'))
    .filter((file) => /^repair_agent_.*_snapshots\.pipe$/.test(file))
    .map((file) => file.replace(/\.pipe$/, ''));

  const jobs = [];
  for (const pipe of targets) {
    const params = new URLSearchParams({
      org_id: user.orgId,
      snapshot_days: snapshotDays.join(','),
      snapshot_generation: String(generation),
      copy_attempt: String(generation),
      _mode: 'append',
    });
    const response = await tinybird(`/v0/pipes/${pipe}/copy?${params}`, { method: 'POST' });
    jobs.push({ pipe, id: response.job.job_id });
  }
  for (const job of jobs) await waitForJob(job);

  const manifest = {
    OrgId: user.orgId,
    SnapshotGeneration: generation,
    SnapshotDays: snapshotDays,
    PublishedAt: formatClickHouseTime(Date.now()),
  };
  await tinybird('/v0/events?name=agent_snapshot_manifest&wait=true', {
    method: 'POST',
    body: JSON.stringify(manifest),
  });
  console.log(
    `[local-stack-seed] published ${targets.length} agent snapshots for ${snapshotDays.length} days`,
  );
}

async function waitForJob({ pipe, id }) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { status, error } = await tinybird(`/v0/jobs/${id}`);
    if (status === 'done') return;
    if (status === 'error' || status === 'cancelled')
      fail(`${pipe} copy failed: ${error ?? status}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`${pipe} copy did not finish within 3 minutes`);
}

async function tinybird(path, init = {}) {
  const response = await fetch(`${tinybirdHost}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tinybirdToken}` },
  });
  const text = await response.text();
  if (!response.ok) fail(`${path.split('?')[0]}: ${response.status} ${text}`);
  return JSON.parse(text);
}

function rewrite(row) {
  const next = { ...row };
  if ('OrgId' in next) next.OrgId = user.orgId;
  if ('ApiKey' in next) next.ApiKey = analyticsKey;
  for (const field of SPAN_TIME_FIELDS) {
    if (next[field] !== undefined) {
      next[field] = BigInt(next[field]) + spanShiftNs;
    }
  }
  for (const field of FACT_TIME_FIELDS) {
    if (typeof next[field] === 'string' && next[field]) {
      next[field] = formatClickHouseTime(parseClickHouseTime(next[field]) + factShiftMs);
    }
  }
  return next;
}

function newestSpanNs() {
  let newest = 0n;
  for (const { rows } of fixtures) {
    for (const row of rows) {
      for (const field of SPAN_TIME_FIELDS) {
        if (row[field] !== undefined && BigInt(row[field]) > newest) newest = BigInt(row[field]);
      }
    }
  }
  return newest;
}

function newestFactMs() {
  let newest = 0;
  for (const { rows } of fixtures) {
    for (const row of rows) {
      for (const field of FACT_TIME_FIELDS) {
        if (typeof row[field] === 'string' && row[field]) {
          newest = Math.max(newest, parseClickHouseTime(row[field]));
        }
      }
    }
  }
  return newest;
}

// Span timestamps are nanosecond integers beyond Number.MAX_SAFE_INTEGER.
function preserveLargeIntegers(_key, value, context) {
  const isLargeInteger =
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context.source);
  return isLargeInteger ? BigInt(context.source) : value;
}

function emitLargeIntegers(_key, value) {
  return typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value;
}

function parseClickHouseTime(value) {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

function formatClickHouseTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

function convexJsonl(args) {
  return convex(args)
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
}

function convexJson(args) {
  return JSON.parse(convex(args));
}

function convex(args) {
  return execFileSync('bunx', ['convex', ...args], { cwd: convexCliDir, encoding: 'utf8' });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function fail(message) {
  console.error(`[local-stack-seed] error: ${message}`);
  process.exit(1);
}
