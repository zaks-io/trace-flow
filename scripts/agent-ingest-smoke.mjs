// Post-deploy production smoke test for the Agent Conversation Analytics cloud ingest path (TRA-110).
//
// Verifies the real path end to end:
//   Collector Credential -> agent-ingest prod Worker -> agent-ingest-prod queue ->
//   agent-consumer prod Worker -> trace_flow_prod Tinybird agent_* -> org-scoped dashboard read.
//
// Secret boundary (non-negotiable): this script never holds a Tinybird admin token. The credential
// is minted through the real authenticated control plane (the production CLI `trace-flow login` or
// the app), and the dashboard read uses an org_id-scoped Tinybird JWT minted the same way the app
// mints it. Both arrive as env inputs; the script only verifies.
//
// Required env:
//   TRACE_FLOW_INGEST_URL          ingest Worker base URL (e.g. https://collector.trace-flow.dev)
//   TRACE_FLOW_SMOKE_COLLECTOR_SECRET   plaintext Collector Credential from the real login flow
//   TRACE_FLOW_SMOKE_ORG_JWT       agent-scoped Tinybird JWT for the smoke org (app/Convex-minted)
//   TRACE_FLOW_TINYBIRD_HOST       Tinybird read host (e.g. https://api.us-west-2.aws.tinybird.co)
// Optional env:
//   TRACE_FLOW_SMOKE_QUEUE         prod queue name for depth checks (default agent-ingest-prod)
//   TRACE_FLOW_SMOKE_DLQ           prod DLQ name for the malformed-path check (default agent-ingest-dlq-prod)
//   TRACE_FLOW_SMOKE_TIMEOUT_MS    poll timeout (default 120000)
//   TRACE_FLOW_SMOKE_READ_PIPE     agent read pipe to assert rows (default agent_sessions_browser)
//   TRACE_FLOW_SMOKE_RETENTION_DAYS retention_days param for the read pipe (default 7)
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
// Reuse the Worker's surrogate-key derivation so the read assertion matches THIS run's session_pk
// (not stale rows), instead of duplicating the UUIDv8 hashing here.
import { hashToUuid } from '../apps/agent-ingest/src/ids.ts';

const ingestUrl = stripSlash(requireEnv('TRACE_FLOW_INGEST_URL'));
const collectorSecret = requireEnv('TRACE_FLOW_SMOKE_COLLECTOR_SECRET');
const orgJwt = requireEnv('TRACE_FLOW_SMOKE_ORG_JWT');
const tinybirdHost = stripSlash(requireEnv('TRACE_FLOW_TINYBIRD_HOST'));
const queueName = process.env.TRACE_FLOW_SMOKE_QUEUE ?? 'agent-ingest-prod';
const dlqName = process.env.TRACE_FLOW_SMOKE_DLQ ?? 'agent-ingest-dlq-prod';
const timeoutMs = Number(process.env.TRACE_FLOW_SMOKE_TIMEOUT_MS ?? 120_000);
const readPipe = process.env.TRACE_FLOW_SMOKE_READ_PIPE ?? 'agent_sessions_browser';
const retentionDays = process.env.TRACE_FLOW_SMOKE_RETENTION_DAYS ?? '7';

// Unique per run so the read assertion can't pass on stale rows.
const nowMs = Date.now();
const vendorSessionId = `smoke-${nowMs}-${randomBytes(4).toString('hex')}`;

try {
  // session_pk = hashToUuid([source, vendor_session_id]) — the same derivation the ingest Worker uses.
  const expectedSessionPk = await hashToUuid(['claude', vendorSessionId]);

  // Baseline before we post so the drain check tolerates concurrent producers on a live prod queue
  // (require the backlog to fall back to where it started, not to absolute zero).
  const baselineDepth = await queueDepth(queueName);

  log(`posting valid envelope to ${ingestUrl}/v1/ingest (session ${vendorSessionId})`);
  await postValidEnvelope();

  log(`waiting for queue ${queueName} to drain to baseline (${baselineDepth})`);
  await waitForQueueDrain(queueName, baselineDepth);

  log(`asserting rows visible through ${readPipe} under org JWT`);
  await assertDashboardRows(expectedSessionPk);

  log('posting malformed envelope (negative path)');
  await assertMalformedRejected();

  log('smoke test passed (production ingest path)');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function buildEnvelope() {
  return {
    batch: {
      source: 'claude',
      collector_batch_id: `smoke-batch-${nowMs}`,
      desktop_version: '99.0.0',
      parser_version: '99.0.0',
    },
    facts: {
      messages: [
        {
          vendor_session_id: vendorSessionId,
          vendor_message_id: `${vendorSessionId}-m0`,
          turn_index: 0,
          role: 'user',
          event_at: nowMs,
          model: '',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cache_creation_5m_tokens: 0,
          cache_creation_1h_tokens: 0,
          reasoning_tokens: 0,
          token_coverage: 'missing',
          cache_coverage: 'missing',
          agent_depth: 0,
          is_subagent_spawn: false,
          is_sidechain: false,
          agent_id: '',
          normalized_git_remote: '',
          repo_path_fallback: 'trace-flow-smoke',
          git_branch: '',
          git_head_sha: '',
          vendor_started_at: null,
          dropped_sensitive: 0,
        },
      ],
      tool_events: [],
      file_events: [],
      capability_snapshots: [],
      pull_request_links: [],
    },
  };
}

async function postEnvelope(envelope) {
  const gz = gzipSync(Buffer.from(JSON.stringify(envelope)));
  return fetch(`${ingestUrl}/v1/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'X-Trace-Flow-Collector-Secret': collectorSecret,
    },
    body: gz,
  });
}

async function postValidEnvelope() {
  const response = await postEnvelope(buildEnvelope());
  if (response.status !== 202) {
    const text = await response.text();
    // 503 policy_unavailable is a known, separately-diagnosable misconfig: the Worker can't load the
    // Convex compatibility policy and fails closed. Name it so the operator goes straight to the cause
    // (empty collectorCompatibilityPolicy table, or a CONVEX_SITE_URL pointing at the wrong deployment)
    // instead of chasing a generic non-202. See runbook "Compatibility policy".
    if (response.status === 503 && text.includes('policy_unavailable')) {
      throw new Error(
        'ingest returned 503 policy_unavailable: the prod Worker cannot load the Convex compatibility ' +
          'policy. Seed an active collectorCompatibilityPolicy row in prod Convex and confirm the ingest ' +
          "Worker's CONVEX_SITE_URL points at the prod deployment. See runbook 'Compatibility policy'.",
      );
    }
    throw new Error(`expected 202 from /v1/ingest, got ${response.status}: ${text.slice(0, 300)}`);
  }
}

async function assertMalformedRejected() {
  // Missing required batch fields + non-array facts: must be rejected at the ingest gate (4xx),
  // never silently accepted. Insert-time failures land in the DLQ; shape failures never enqueue.
  const before = await queueDepth(dlqName);
  const response = await fetch(`${ingestUrl}/v1/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Flow-Collector-Secret': collectorSecret,
    },
    body: JSON.stringify({ batch: {}, facts: { messages: 'not-an-array' } }),
  });
  if (response.status < 400 || response.status >= 500) {
    throw new Error(`malformed envelope expected a 4xx rejection, got ${response.status}`);
  }
  // A shape-rejected envelope must not enqueue, so the DLQ must not grow from this POST.
  const after = await queueDepth(dlqName);
  if (after > before) {
    throw new Error(`malformed envelope unexpectedly enqueued (DLQ grew ${before} -> ${after})`);
  }
}

async function assertDashboardRows(expectedSessionPk) {
  await waitUntil(
    async () => {
      const url = new URL(`/v0/pipes/${readPipe}.json`, tinybirdHost);
      url.searchParams.set('retention_days', retentionDays);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${orgJwt}` } });
      if (!response.ok) return false;
      const body = await response.json().catch(() => ({}));
      const rows = Array.isArray(body?.data) ? body.data : [];
      return rows.some((r) => r.session_pk === expectedSessionPk);
    },
    timeoutMs,
    3000,
    `session ${vendorSessionId} did not appear via ${readPipe} under org JWT within ${timeoutMs}ms`,
  );
}

async function waitForQueueDrain(name, baselineDepth = 0) {
  await waitUntil(
    async () => (await queueDepth(name)) <= baselineDepth,
    timeoutMs,
    3000,
    `queue ${name} did not drain back to baseline (${baselineDepth}) within ${timeoutMs}ms`,
  );
}

// Backlog depth via wrangler. Uses CLOUDFLARE_API_TOKEN/ACCOUNT_ID from the environment.
function queueDepth(name) {
  const result = spawnSync('bunx', ['wrangler', 'queues', 'info', name, '--json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    // Some wrangler versions lack `--json`; fall back to parsing the labeled "Backlog" table row,
    // e.g. "Backlog size │ 0 messages". Anchored to the field label to avoid matching a stray number.
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const match = /backlog(?:\s+size)?\s*[:│|]?\s*(\d+)/i.exec(text);
    if (match) return Number(match[1]);
    throw new Error(`wrangler queues info ${name} failed: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(result.stdout);
  return Number(parsed?.backlog ?? parsed?.queue?.backlog ?? parsed?.messages ?? 0);
}

async function waitUntil(predicate, maxMs, intervalMs, errorMessage) {
  const deadline = Date.now() + maxMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(lastError ? `${errorMessage}: ${lastError.message}` : errorMessage);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripSlash(value) {
  return value.replace(/\/+$/, '');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`missing required env ${name}`);
  return value;
}

function log(message) {
  console.log(`[agent-ingest-smoke] ${message}`);
}

function fail(message) {
  console.error(`[agent-ingest-smoke] error: ${message}`);
  process.exit(1);
}
