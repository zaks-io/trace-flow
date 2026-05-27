import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const root = process.env.TRACE_FLOW_ROOT ?? process.cwd();
const devDir = process.env.TRACE_FLOW_DEV_DIR ?? path.join(root, 'scripts/dev');
const stateDir = process.env.TRACE_FLOW_STATE_DIR ?? path.join(root, '.trace-flow');
const devEnvPath = process.env.TRACE_FLOW_DEV_ENV ?? path.join(stateDir, 'dev.env');

loadDevEnv(devEnvPath);

const tinybirdInfo = discoverTinybirdLocal();
const tinybirdHost = stripTrailingSlash(
  tinybirdInfo?.api ?? process.env.TRACE_FLOW_TINYBIRD_HOST ?? 'http://127.0.0.1:7181',
);
const tinybirdToken = tinybirdInfo?.token ?? process.env.TB_LOCAL_WORKSPACE_TOKEN;
const workerUrl = stripTrailingSlash(process.env.TRACE_FLOW_WORKER_URL ?? 'http://127.0.0.1:8787');
const timeoutMs = Number(process.env.TRACE_FLOW_SMOKE_TIMEOUT_MS ?? 60_000);
const tinybirdOnly =
  process.env.TRACE_FLOW_SMOKE_TINYBIRD_ONLY === '1' || process.argv.includes('--tinybird-only');
const startWorkers =
  !tinybirdOnly &&
  process.env.TRACE_FLOW_SMOKE_START_WORKERS !== '0' &&
  !process.argv.includes('--no-start-workers');

if (!tinybirdToken) {
  fail(`missing TB_LOCAL_WORKSPACE_TOKEN in ${devEnvPath}; run scripts/dev/start.sh first`);
}

const nowMs = Date.now();
const nowNs = BigInt(nowMs) * 1_000_000n;
const traceId = process.env.TRACE_FLOW_SMOKE_TRACE_ID ?? randomBytes(16).toString('hex');
const spanId = process.env.TRACE_FLOW_SMOKE_SPAN_ID ?? randomBytes(8).toString('hex');
const apiKey =
  process.env.TRACE_FLOW_SMOKE_API_KEY ?? `tf-smoke-${nowMs}-${randomBytes(4).toString('hex')}`;
const orgId = process.env.TRACE_FLOW_SMOKE_ORG_ID ?? 'org_smoke_local';

let workers;

try {
  log('checking Tinybird Local');
  await tinybirdSql('SELECT 1 AS ok');

  if (tinybirdOnly) {
    log('inserting smoke trace directly into Tinybird');
    await insertTinybirdTrace();
  } else {
    await seedLocalApiKey();
    workers = await ensureWorkers();
    await postOtlpTrace();
  }

  log(`waiting for trace ${traceId} in Tinybird`);
  await waitForTrace();

  log('checking Tinybird endpoint query');
  await assertTraceSummary();

  log(`smoke test passed (${tinybirdOnly ? 'tinybird-only' : 'runtime'})`);
} finally {
  if (workers?.started) {
    log('stopping smoke worker process');
    stopProcessGroup(workers.process);
  }
}

function loadDevEnv(file) {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    process.env[key] ??= value;
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function log(message) {
  console.log(`[trace-flow-smoke] ${message}`);
}

function fail(message) {
  console.error(`[trace-flow-smoke] error: ${message}`);
  process.exit(1);
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: opts.quiet ? 'pipe' : 'inherit',
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const suffix = stderr ? `\n${stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${suffix}`);
  }

  return result.stdout ?? '';
}

function discoverTinybirdLocal() {
  try {
    const output = run('tb', ['--output=json', 'info'], { quiet: true });
    const parsed = JSON.parse(output);
    if (parsed?.local?.token) {
      return {
        api: parsed.local.api,
        token: parsed.local.token,
      };
    }
  } catch {
    // Fall back to .trace-flow/dev.env. The explicit Tinybird probe below will fail clearly if stale.
  }
  return null;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }

  return { response, body };
}

async function tinybirdSql(sql) {
  const url = new URL('/v0/sql', tinybirdHost);
  const query = /\bFORMAT\s+/i.test(sql) ? sql : `${sql} FORMAT JSON`;
  url.searchParams.set('q', query);
  const { body } = await fetchJson(url, {
    headers: { Authorization: `Bearer ${tinybirdToken}` },
  });
  return body;
}

async function tinybirdEvents(datasource, rows) {
  const url = new URL('/v0/events', tinybirdHost);
  url.searchParams.set('name', datasource);
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await fetchJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tinybirdToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });
}

async function seedLocalApiKey() {
  log('seeding local Worker KV');
  const expiresAt = nowMs + 24 * 60 * 60 * 1000;
  const periodEnd = nowMs + 30 * 24 * 60 * 60 * 1000;
  const apiKeyRecord = JSON.stringify({ expiresAt, createdAt: nowMs, orgId });
  const subscriptionRecord = JSON.stringify({
    tier: 'pro',
    status: 'active',
    monthlyUnits: 100_000,
    addonUnits: 0,
    currentPeriodStart: nowMs,
    currentPeriodEnd: periodEnd,
  });

  const baseArgs = [
    'wrangler',
    'kv',
    'key',
    'put',
    '--config',
    'apps/proxy/wrangler.toml',
    '--binding',
    'API_KEYS',
    '--local',
    '--persist-to',
    '.wrangler/state',
  ];

  run('bunx', [...baseArgs, apiKey, apiKeyRecord], { quiet: true });
  run('bunx', [...baseArgs, `sub:${orgId}`, subscriptionRecord], { quiet: true });
}

async function ensureWorkers() {
  if (await endpointReady(`${workerUrl}/openapi.json`)) {
    log(`using existing Worker dev server at ${workerUrl}`);
    return { started: false };
  }

  if (!startWorkers) {
    throw new Error(
      `Worker dev server is not reachable at ${workerUrl}; start scripts/dev/workers.sh or remove --no-start-workers`,
    );
  }

  log('starting Worker dev server');
  const logPath = path.join(stateDir, 'smoke-workers.log');
  const logFd = openSync(logPath, 'a');
  const child = spawn('bash', [path.join(devDir, 'workers.sh')], {
    cwd: root,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);

  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[trace-flow-smoke] worker process exited with ${code}`);
    } else if (signal) {
      console.error(`[trace-flow-smoke] worker process exited with ${signal}`);
    }
  });

  try {
    await waitUntil(
      () => endpointReady(`${workerUrl}/openapi.json`),
      timeoutMs,
      1000,
      `Worker dev server did not become ready. See ${logPath}`,
    );
  } catch (error) {
    stopProcessGroup(child);
    throw error;
  }

  return { started: true, process: child };
}

async function endpointReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

function otlpPayload() {
  const endNs = nowNs + 50_000_000n;
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'trace-flow-smoke' } },
            { key: 'deployment.environment', value: { stringValue: 'local' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'scripts/dev/smoke' },
            spans: [
              {
                traceId,
                spanId,
                name: 'trace-flow smoke',
                kind: 3,
                startTimeUnixNano: nowNs.toString(),
                endTimeUnixNano: endNs.toString(),
                status: { code: 1, message: '' },
                attributes: [
                  { key: 'trace_flow.source', value: { stringValue: 'proxy' } },
                  { key: 'baggage.operation', value: { stringValue: 'smoke-test' } },
                  { key: 'gen_ai.system', value: { stringValue: 'smoke' } },
                  { key: 'gen_ai.request.model', value: { stringValue: 'smoke-model' } },
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: '1' } },
                  { key: 'gen_ai.usage.output_tokens', value: { intValue: '1' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function postOtlpTrace() {
  log('posting OTLP smoke trace through Worker');
  const { response, body } = await fetchJson(`${workerUrl}/v1/traces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Flow-Api-Key': apiKey,
    },
    body: JSON.stringify(otlpPayload()),
  });

  const recording = response.headers.get('X-Trace-Flow-Recording');
  if (recording !== 'true') {
    throw new Error(
      `Worker accepted the request but did not record it: ${JSON.stringify(body).slice(0, 500)}`,
    );
  }
}

async function insertTinybirdTrace() {
  await tinybirdEvents('otel_traces', [
    {
      ReceivedAt: Number(nowNs),
      Timestamp: Number(nowNs),
      TraceId: traceId,
      SpanId: spanId,
      ParentSpanId: '',
      TraceState: '',
      SpanName: 'trace-flow smoke',
      SpanKind: 'SPAN_KIND_CLIENT',
      ServiceName: 'trace-flow-smoke',
      ResourceAttributes: JSON.stringify({ 'service.name': 'trace-flow-smoke' }),
      SpanAttributes: JSON.stringify({
        'trace_flow.source': 'proxy',
        'baggage.operation': 'smoke-test',
        'gen_ai.system': 'smoke',
        'gen_ai.request.model': 'smoke-model',
        'gen_ai.usage.input_tokens': '1',
        'gen_ai.usage.output_tokens': '1',
      }),
      Duration: 50_000_000,
      StatusCode: 'STATUS_CODE_OK',
      StatusMessage: '',
      ApiKey: apiKey,
      'Events.Timestamp': [],
      'Events.Name': [],
      'Events.Attributes': [],
      'Links.TraceId': [],
      'Links.SpanId': [],
      'Links.TraceState': [],
      'Links.Attributes': [],
      TierAtIngestion: 'hobby',
      RetentionExpiresAt: Number(nowNs + 7n * 24n * 60n * 60n * 1_000_000_000n),
    },
  ]);
}

async function waitForTrace() {
  await waitUntil(
    async () => {
      const sql = [
        'SELECT count() AS count',
        'FROM otel_traces FINAL',
        `WHERE TraceId = '${traceId}'`,
        `AND ApiKey = '${apiKey}'`,
      ].join(' ');
      const body = await tinybirdSql(sql);
      const count = Number(body?.data?.[0]?.count ?? 0);
      return count > 0;
    },
    timeoutMs,
    2000,
    `trace ${traceId} did not appear in Tinybird within ${timeoutMs}ms`,
  );
}

async function assertTraceSummary() {
  const url = new URL('/v0/pipes/mcp_trace_summaries.json', tinybirdHost);
  url.searchParams.set('api_keys', apiKey);
  url.searchParams.set('retention_days', '7');
  url.searchParams.set('trace_id', traceId);
  const { body } = await fetchJson(url, {
    headers: { Authorization: `Bearer ${tinybirdToken}` },
  });

  const rows = Array.isArray(body?.data) ? body.data : [];
  if (rows.length === 0) {
    throw new Error(`mcp_trace_summaries returned no rows for trace ${traceId}`);
  }
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

  if (lastError) {
    throw new Error(`${errorMessage}: ${lastError.message}`);
  }
  throw new Error(errorMessage);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopProcessGroup(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      child.kill('SIGTERM');
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Process already exited.
    }
  }
}
