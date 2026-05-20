/**
 * Live OpenRouter parser integration test.
 *
 * Hits the real OpenRouter API directly (not via the proxy), captures the raw
 * response bytes, then runs the proxy's actual parsers on them. Verifies that
 * what we extract matches OpenRouter's own `usage` block — the same path that
 * runs in production. Useful when traces look incomplete in prod and we want
 * to rule out parser drift against current OpenRouter response shapes.
 */
import type { SSEStreamData, LLMResponseMetadata, LLMTokenUsage } from '@trace-flow/types';
import { parseTokenUsage, getProvider } from '@trace-flow/llm-providers';
import { createParser } from 'eventsource-parser';
import { getCurrentTimestamp } from '@trace-flow/utils';
import { requireEnv, log, success, error } from './config';

const openrouter = getProvider('openrouter');

function createSSEParser(streamData: SSEStreamData): ReturnType<typeof createParser> {
  return createParser({
    onEvent(event) {
      openrouter.handleSSEEvent(event, getCurrentTimestamp(), streamData);
    },
  });
}

const aggregateSSETokens = (streamData: SSEStreamData): LLMTokenUsage | undefined =>
  openrouter.aggregateSSETokens(streamData);

const extractMetadataFromResponseBody = (body: string): Partial<LLMResponseMetadata> | undefined =>
  openrouter.parseResponseMetadata(body);

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';

interface CheckResult {
  ok: boolean;
  details: string[];
}

function check(label: string, ok: boolean, detail: string): void {
  const symbol = ok ? '✓' : '✗';
  console.log(`    ${symbol} ${label}: ${detail}`);
}

function assertParsed(
  parsed: ReturnType<typeof parseTokenUsage>,
  source: 'body' | 'sse',
): CheckResult {
  const details: string[] = [];
  let ok = true;

  if (!parsed) {
    return { ok: false, details: [`parser returned undefined for ${source}`] };
  }

  const promptOk = (parsed.promptTokens ?? 0) > 0;
  check('promptTokens > 0', promptOk, String(parsed.promptTokens));
  ok &&= promptOk;

  const completionOk = (parsed.completionTokens ?? 0) > 0;
  check('completionTokens > 0', completionOk, String(parsed.completionTokens));
  ok &&= completionOk;

  const totalOk = (parsed.totalTokens ?? 0) > 0;
  check('totalTokens > 0', totalOk, String(parsed.totalTokens));
  ok &&= totalOk;

  const sumOk = parsed.totalTokens === (parsed.promptTokens ?? 0) + (parsed.completionTokens ?? 0);
  check('totalTokens == prompt + completion', sumOk, sumOk ? 'matches' : 'mismatch');
  ok &&= sumOk;

  const costOk = parsed.upstreamCost !== undefined && parsed.upstreamCost >= 0;
  check('upstreamCost extracted', costOk, String(parsed.upstreamCost));
  ok &&= costOk;

  const uncachedOk = parsed.uncachedInputTokens !== undefined && parsed.uncachedInputTokens >= 0;
  check('uncachedInputTokens computed', uncachedOk, String(parsed.uncachedInputTokens));
  ok &&= uncachedOk;

  return { ok, details };
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

function compareToReportedUsage(
  parsedTokens: ReturnType<typeof parseTokenUsage>,
  reported: OpenRouterUsage | undefined,
): boolean {
  if (!parsedTokens || !reported) return false;
  let ok = true;

  const promptMatches = parsedTokens.promptTokens === reported.prompt_tokens;
  check(
    'promptTokens matches OpenRouter usage.prompt_tokens',
    promptMatches,
    `${parsedTokens.promptTokens} vs ${reported.prompt_tokens}`,
  );
  ok &&= promptMatches;

  const completionMatches = parsedTokens.completionTokens === reported.completion_tokens;
  check(
    'completionTokens matches OpenRouter usage.completion_tokens',
    completionMatches,
    `${parsedTokens.completionTokens} vs ${reported.completion_tokens}`,
  );
  ok &&= completionMatches;

  if (reported.cost !== undefined) {
    const costMatches = parsedTokens.upstreamCost === reported.cost;
    check(
      'upstreamCost matches OpenRouter usage.cost',
      costMatches,
      `${parsedTokens.upstreamCost} vs ${reported.cost}`,
    );
    ok &&= costMatches;
  }

  return ok;
}

async function testNonStreamingParse(apiKey: string): Promise<boolean> {
  log('OpenRouter:parser', 'Non-streaming: hitting real OpenRouter API...');

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word: pong.' }],
      max_tokens: 20,
      usage: { include: true },
    }),
  });

  if (!res.ok) {
    error('OpenRouter:parser', `Non-streaming HTTP ${res.status}: ${await res.text()}`);
    return false;
  }

  const body = await res.text();
  console.log(`    body bytes: ${body.length}`);

  const reportedUsage = (JSON.parse(body) as { usage?: OpenRouterUsage }).usage;
  console.log(`    OpenRouter reported usage: ${JSON.stringify(reportedUsage)}`);

  const parsed = parseTokenUsage(body, 'openrouter');
  console.log(`    parser result: ${JSON.stringify(parsed)}`);

  const metadata = extractMetadataFromResponseBody(body);
  console.log(
    `    metadata: id=${metadata?.id} model=${metadata?.model} finish=${metadata?.finishReason}`,
  );

  const parserChecks = assertParsed(parsed, 'body');
  const matchOk = compareToReportedUsage(parsed, reportedUsage);
  const metadataOk = !!metadata?.id && !!metadata?.model;
  check('metadata extracted (id + model)', metadataOk, `${metadata?.id} / ${metadata?.model}`);

  const ok = parserChecks.ok && matchOk && metadataOk;
  if (ok) success('OpenRouter:parser', 'Non-streaming parse OK');
  else error('OpenRouter:parser', 'Non-streaming parse FAILED');
  return ok;
}

async function testStreamingParse(apiKey: string): Promise<boolean> {
  log('OpenRouter:parser', 'Streaming: hitting real OpenRouter API (SSE)...');

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
      max_tokens: 50,
      stream: true,
      usage: { include: true },
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok || !res.body) {
    error('OpenRouter:parser', `Streaming HTTP ${res.status}: ${res.statusText}`);
    return false;
  }

  const streamData: SSEStreamData = { messages: [] };
  const parser = createSSEParser(streamData);
  const decoder = new TextDecoder();
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();

  let totalBytes = 0;
  let lastFewLines = '';
  // Capture the raw event-stream so we can spot OpenRouter quirks (comments, finalisers).
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    const text = decoder.decode(value, { stream: true });
    lastFewLines = (lastFewLines + text).slice(-2000);
    parser.feed(text);
  }
  parser.feed('\n\n');
  console.log(`    total stream bytes: ${totalBytes}`);
  console.log(`    SSE messages parsed: ${streamData.messages.length}`);

  const aggregated = aggregateSSETokens(streamData);
  console.log(`    aggregated usage: ${JSON.stringify(aggregated)}`);

  // Pull out what OpenRouter actually reported in its terminal usage chunk
  let reportedUsage: OpenRouterUsage | undefined;
  for (const msg of streamData.messages) {
    if (msg.usage?.input_tokens || msg.usage?.output_tokens) {
      reportedUsage = {
        prompt_tokens: msg.usage.input_tokens,
        completion_tokens: msg.usage.output_tokens,
        cost: msg.usage.cost,
      };
    }
  }
  console.log(`    raw SSE-extracted usage: ${JSON.stringify(reportedUsage)}`);

  const parserChecks = assertParsed(aggregated, 'sse');
  const lastMessage = streamData.messages[streamData.messages.length - 1];
  const finishReasonOk = !!lastMessage?.metadata?.finishReason;
  check('finish_reason extracted', finishReasonOk, String(lastMessage?.metadata?.finishReason));
  const modelOk = !!lastMessage?.metadata?.model;
  check('model extracted from SSE', modelOk, String(lastMessage?.metadata?.model));

  const ok = parserChecks.ok && finishReasonOk && modelOk;
  if (!ok) {
    console.log('    last 500 bytes of stream for inspection:');
    console.log(`    ${lastFewLines.slice(-500).replace(/\n/g, '\\n')}`);
  }

  if (ok) success('OpenRouter:parser', 'Streaming parse OK');
  else error('OpenRouter:parser', 'Streaming parse FAILED');
  return ok;
}

async function main() {
  console.log('='.repeat(60));
  console.log('OpenRouter LIVE Parser Integration Test');
  console.log(`Model: ${MODEL}`);
  console.log(`Endpoint: ${OPENROUTER_URL}`);
  console.log('='.repeat(60));

  const apiKey = requireEnv('OPENROUTER_API_KEY');

  const results = await Promise.all([testNonStreamingParse(apiKey), testStreamingParse(apiKey)]);

  const allPassed = results.every(Boolean);
  console.log('='.repeat(60));
  console.log(allPassed ? '✓ ALL PARSER CHECKS PASSED' : '✗ PARSER CHECKS FAILED');
  console.log('='.repeat(60));
  process.exit(allPassed ? 0 : 1);
}

void main();
