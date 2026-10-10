import { createHash, randomBytes } from 'node:crypto';
import { localStackAccount } from './local-stack-convex.mjs';

const tinybirdHost = requireLocalUrl('TRACE_FLOW_TINYBIRD_HOST');
const tinybirdToken = requireEnv('TINYBIRD_WORKSPACE_TOKEN');
const workerUrl = requireLocalUrl('STACK_PROXY_URL');
const timeoutMs = Number(process.env.TRACE_FLOW_SMOKE_TIMEOUT_MS ?? 120_000);
const tinybirdOnly = process.argv.includes('--tinybird-only');
for (const arg of process.argv.slice(2)) {
  if (arg !== '--tinybird-only') throw new Error(`unknown smoke argument: ${arg}`);
}

const nowMs = Date.now();
const nowNs = BigInt(nowMs) * 1_000_000n;
const traceId = process.env.TRACE_FLOW_SMOKE_TRACE_ID ?? randomBytes(16).toString('hex');
const spanId = process.env.TRACE_FLOW_SMOKE_SPAN_ID ?? randomBytes(8).toString('hex');
let apiKey;
let analyticsKey;

try {
  log('checking Tinybird Local');
  await tinybirdSql('SELECT 1 AS ok');

  if (tinybirdOnly) {
    apiKey = randomBytes(32).toString('hex');
  } else {
    const { apiKeys } = localStackAccount(requireEnv('STACK_EMAIL'));
    const key = apiKeys.find(
      (record) =>
        typeof record.key === 'string' &&
        record.key &&
        record.expiresAt > nowMs &&
        (record.permissions ?? ['ingest']).includes('ingest'),
    );
    if (!key)
      throw new Error('org has no unexpired ingest API key; create one in the web app first');
    apiKey = key.key;
  }
  analyticsKey = `sha256:${createHash('sha256').update(apiKey).digest('hex')}`;

  if (tinybirdOnly) {
    log('inserting smoke trace directly into Tinybird');
    await insertTinybirdTrace();
  } else {
    await postOtlpTrace();
  }

  log(`waiting for trace ${traceId} in Tinybird`);
  await waitForTrace();

  log('checking Tinybird endpoint query');
  await assertTraceSummary();

  log(`smoke test passed (${tinybirdOnly ? 'tinybird-only' : 'runtime'})`);
} catch (error) {
  console.error(`[trace-flow-smoke] ${error.message}`);
  process.exitCode = 1;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run scripts/dev/local-stack.sh smoke`);
  return value;
}

function requireLocalUrl(name) {
  const url = new URL(requireEnv(name));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error(`${name} must use local loopback HTTP`);
  }
  return stripTrailingSlash(url.href);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function log(message) {
  console.log(`[trace-flow-smoke] ${message}`);
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
    throw new Error(`local smoke endpoint returned HTTP ${response.status}`);
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
            scope: { name: 'scripts/dev/local-stack-smoke' },
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
  const { response } = await fetchJson(`${workerUrl}/v1/traces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Flow-Api-Key': apiKey,
    },
    body: JSON.stringify(otlpPayload()),
  });

  const recording = response.headers.get('X-Trace-Flow-Recording');
  if (recording !== 'true') {
    throw new Error('Worker accepted the request but did not record it');
  }
}

async function insertTinybirdTrace() {
  await tinybirdEvents('otel_trace_spans', [
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
      ApiKey: analyticsKey,
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
        'FROM otel_trace_spans',
        `WHERE TraceId = '${traceId}'`,
        `AND ApiKey = '${analyticsKey}'`,
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
  url.searchParams.set('api_keys', analyticsKey);
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
