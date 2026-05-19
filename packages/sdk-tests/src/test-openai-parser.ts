/**
 * Live OpenAI parser integration test.
 *
 * Hits real OpenAI endpoints directly (NOT via the proxy), captures the raw
 * response bytes/SSE chunks, then runs the proxy's actual parsers on them.
 * Verifies that every field we extract matches OpenAI's own response shape —
 * the same path that runs in production. Useful when traces look wrong in prod
 * (missing model, empty tokens, etc.) and we need to rule out parser drift
 * against current OpenAI response shapes for both Chat Completions and the
 * Responses API.
 *
 * Surfaces (does not auto-fix) parser bugs.
 */
import type { SSEStreamData, LLMTokenUsage, LLMResponseMetadata } from '@trace-flow/types';
import { parseTokenUsage, getProvider } from '@trace-flow/llm-providers';
import { createParser } from 'eventsource-parser';
import { getCurrentTimestamp } from '@trace-flow/utils';
import { requireEnv, log, success, error } from './config';

const openai = getProvider('openai');

function createSSEParser(streamData: SSEStreamData): ReturnType<typeof createParser> {
  return createParser({
    onEvent(event) {
      openai.handleSSEEvent(event, getCurrentTimestamp(), streamData);
    },
  });
}

const aggregateSSETokens = (streamData: SSEStreamData): LLMTokenUsage | undefined =>
  openai.aggregateSSETokens(streamData);

const extractMetadataFromResponseBody = (body: string): Partial<LLMResponseMetadata> | undefined =>
  openai.parseResponseMetadata(body);

const parseOpenAIStyleRequestBody = (body: string) => openai.parseRequestBody(body);

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CHAT_MODEL = 'gpt-4o-mini';
const RESPONSES_MODEL = 'gpt-4.1-mini';

interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface CheckResult {
  ok: boolean;
  failures: string[];
}

function check(failures: string[], label: string, ok: boolean, detail: string): boolean {
  const symbol = ok ? '✓' : '✗';
  console.log(`    ${symbol} ${label}: ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
  return ok;
}

function assertTokens(
  parsed: LLMTokenUsage | undefined,
  reported: OpenAIChatUsage | OpenAIResponsesUsage | undefined,
  options: { expectCacheRead?: boolean; expectReasoning?: boolean } = {},
): CheckResult {
  const failures: string[] = [];

  if (!parsed) {
    return { ok: false, failures: ['parser returned undefined'] };
  }
  if (!reported) {
    return { ok: false, failures: ['no upstream-reported usage to compare against'] };
  }

  const r = reported as OpenAIChatUsage & OpenAIResponsesUsage;
  const reportedPrompt = r.prompt_tokens ?? r.input_tokens;
  const reportedCompletion = r.completion_tokens ?? r.output_tokens;
  const reportedCached =
    r.prompt_tokens_details?.cached_tokens ?? r.input_tokens_details?.cached_tokens;
  const reportedReasoning =
    r.completion_tokens_details?.reasoning_tokens ?? r.output_tokens_details?.reasoning_tokens;

  check(
    failures,
    'promptTokens matches OpenAI',
    parsed.promptTokens === reportedPrompt,
    `${parsed.promptTokens} vs ${reportedPrompt}`,
  );
  check(
    failures,
    'completionTokens matches OpenAI',
    parsed.completionTokens === reportedCompletion,
    `${parsed.completionTokens} vs ${reportedCompletion}`,
  );
  check(
    failures,
    'totalTokens matches OpenAI',
    parsed.totalTokens === reported.total_tokens,
    `${parsed.totalTokens} vs ${reported.total_tokens}`,
  );

  const uncachedExpected = Math.max(0, (reportedPrompt ?? 0) - (reportedCached ?? 0));
  check(
    failures,
    'uncachedInputTokens derived correctly',
    parsed.uncachedInputTokens === uncachedExpected,
    `${parsed.uncachedInputTokens} vs ${uncachedExpected}`,
  );

  if (options.expectCacheRead && reportedCached && reportedCached > 0) {
    check(
      failures,
      'cacheReadTokens matches OpenAI cached_tokens',
      parsed.cacheReadTokens === reportedCached,
      `${parsed.cacheReadTokens} vs ${reportedCached}`,
    );
  } else if (reportedCached !== undefined && reportedCached > 0) {
    // Even if not expected, when OpenAI reports cache reads we should capture them
    check(
      failures,
      'cacheReadTokens matches (even when unexpected)',
      parsed.cacheReadTokens === reportedCached,
      `${parsed.cacheReadTokens} vs ${reportedCached}`,
    );
  }

  if (options.expectReasoning && reportedReasoning !== undefined) {
    check(
      failures,
      'reasoningTokens matches OpenAI reasoning_tokens',
      parsed.reasoningTokens === reportedReasoning,
      `${parsed.reasoningTokens} vs ${reportedReasoning}`,
    );
  } else if (reportedReasoning !== undefined && reportedReasoning > 0) {
    check(
      failures,
      'reasoningTokens matches OpenAI reasoning_tokens',
      parsed.reasoningTokens === reportedReasoning,
      `${parsed.reasoningTokens} vs ${reportedReasoning}`,
    );
  }

  return { ok: failures.length === 0, failures };
}

function assertMetadata(
  meta: Partial<LLMResponseMetadata> | undefined,
  expected: {
    expectId?: boolean;
    expectModel?: string | RegExp;
    expectObject?: string;
    expectCreated?: boolean;
    expectFinishReason?: string | RegExp;
  },
): CheckResult {
  const failures: string[] = [];

  if (!meta) {
    failures.push('metadata is undefined');
    return { ok: false, failures };
  }

  if (expected.expectId) {
    check(
      failures,
      'metadata.id extracted',
      !!meta.id && meta.id.length > 0,
      meta.id ?? '<missing>',
    );
  }
  if (expected.expectModel) {
    const matcher = expected.expectModel;
    const ok =
      !!meta.model &&
      (typeof matcher === 'string' ? meta.model.includes(matcher) : matcher.test(meta.model));
    check(failures, `metadata.model matches ${String(matcher)}`, ok, meta.model ?? '<missing>');
  }
  if (expected.expectObject) {
    check(
      failures,
      `metadata.object is "${expected.expectObject}"`,
      meta.object === expected.expectObject,
      meta.object ?? '<missing>',
    );
  }
  if (expected.expectCreated) {
    check(
      failures,
      'metadata.created extracted (epoch seconds)',
      typeof meta.created === 'number' && meta.created > 1_600_000_000,
      String(meta.created),
    );
  }
  if (expected.expectFinishReason) {
    const matcher = expected.expectFinishReason;
    const ok =
      !!meta.finishReason &&
      (typeof matcher === 'string'
        ? meta.finishReason === matcher
        : matcher.test(meta.finishReason));
    check(
      failures,
      `metadata.finishReason matches ${String(matcher)}`,
      ok,
      meta.finishReason ?? '<missing>',
    );
  }

  return { ok: failures.length === 0, failures };
}

async function fetchJson(url: string, apiKey: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function fetchSSE(url: string, apiKey: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

async function readStreamToData(
  res: Response,
): Promise<{ streamData: SSEStreamData; rawTail: string; totalBytes: number }> {
  const streamData: SSEStreamData = { messages: [] };
  const parser = createSSEParser(streamData);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let totalBytes = 0;
  let rawTail = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    const text = decoder.decode(value, { stream: true });
    rawTail = (rawTail + text).slice(-3000);
    parser.feed(text);
  }
  parser.feed('\n\n');

  return { streamData, rawTail, totalBytes };
}

async function testChatNonStreaming(apiKey: string): Promise<boolean> {
  log('OpenAI:chat', 'Non-streaming: hitting real /v1/chat/completions...');

  const requestBody = {
    model: CHAT_MODEL,
    messages: [{ role: 'user' as const, content: 'Reply with the single word: pong.' }],
    max_tokens: 20,
  };
  const res = await fetchJson(OPENAI_CHAT_URL, apiKey, requestBody);

  if (!res.ok) {
    error('OpenAI:chat', `Non-streaming HTTP ${res.status}: ${await res.text()}`);
    return false;
  }

  const body = await res.text();
  console.log(`    body bytes: ${body.length}`);
  const parsedRes = JSON.parse(body) as {
    id?: string;
    model?: string;
    object?: string;
    created?: number;
    choices?: { finish_reason?: string }[];
    usage?: OpenAIChatUsage;
  };
  console.log(`    OpenAI reported usage: ${JSON.stringify(parsedRes.usage)}`);

  const parsed = parseTokenUsage(body, 'openai');
  console.log(`    parser tokens: ${JSON.stringify(parsed)}`);

  const metadata = extractMetadataFromResponseBody(body);
  console.log(`    parser metadata: ${JSON.stringify(metadata)}`);

  const inputMessages = parseOpenAIStyleRequestBody(JSON.stringify(requestBody));
  console.log(`    parser input messages: ${JSON.stringify(inputMessages)}`);

  const tokenChecks = assertTokens(parsed, parsedRes.usage);
  const metadataChecks = assertMetadata(metadata, {
    expectId: true,
    expectModel: CHAT_MODEL,
    expectObject: 'chat.completion',
    expectCreated: true,
    expectFinishReason: /^(stop|length)$/,
  });

  const inputOk = check(
    [],
    'input messages parsed',
    !!inputMessages && inputMessages.length === 1 && inputMessages[0]?.role === 'user',
    `count=${inputMessages?.length}`,
  );

  const ok = tokenChecks.ok && metadataChecks.ok && inputOk;
  if (ok) success('OpenAI:chat', 'Non-streaming parse OK');
  else error('OpenAI:chat', 'Non-streaming parse FAILED');
  return ok;
}

async function testChatStreaming(apiKey: string): Promise<boolean> {
  log('OpenAI:chat', 'Streaming: hitting real /v1/chat/completions (SSE)...');

  const res = await fetchSSE(OPENAI_CHAT_URL, apiKey, {
    model: CHAT_MODEL,
    messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
    max_tokens: 50,
    stream: true,
    stream_options: { include_usage: true },
  });

  if (!res.ok || !res.body) {
    error('OpenAI:chat', `Streaming HTTP ${res.status}: ${res.statusText}`);
    return false;
  }

  const { streamData, rawTail, totalBytes } = await readStreamToData(res);
  console.log(`    stream bytes: ${totalBytes}, parsed messages: ${streamData.messages.length}`);

  const aggregated = aggregateSSETokens(streamData);
  console.log(`    aggregated tokens: ${JSON.stringify(aggregated)}`);

  const lastMessage = streamData.messages[streamData.messages.length - 1];
  console.log(`    last message metadata: ${JSON.stringify(lastMessage?.metadata)}`);
  console.log(`    last message usage: ${JSON.stringify(lastMessage?.usage)}`);

  // The SSE stream's final chunk carries the actual usage block from OpenAI
  const upstreamUsage: OpenAIChatUsage | undefined = lastMessage?.usage
    ? {
        prompt_tokens: lastMessage.usage.input_tokens,
        completion_tokens: lastMessage.usage.output_tokens,
        total_tokens:
          lastMessage.usage.input_tokens !== undefined &&
          lastMessage.usage.output_tokens !== undefined
            ? lastMessage.usage.input_tokens + lastMessage.usage.output_tokens
            : undefined,
        prompt_tokens_details: lastMessage.usage.cached_tokens
          ? { cached_tokens: lastMessage.usage.cached_tokens }
          : undefined,
      }
    : undefined;

  const tokenChecks = assertTokens(aggregated, upstreamUsage);
  const metadataChecks = assertMetadata(lastMessage?.metadata ?? {}, {
    expectId: true,
    expectModel: CHAT_MODEL,
    expectObject: 'chat.completion.chunk',
    expectCreated: true,
    expectFinishReason: /^(stop|length)$/,
  });

  // TTFT requires at least one content_block_delta event before the final usage chunk.
  const failures: string[] = [];
  const hasDelta =
    !!lastMessage?.events && lastMessage.events.some((e) => e.type === 'content_block_delta');
  check(failures, 'TTFT delta event present', hasDelta, `delta events found: ${hasDelta}`);

  const ok = tokenChecks.ok && metadataChecks.ok && failures.length === 0;
  if (!ok) {
    console.log('    last 500 bytes of stream:');
    console.log(`    ${rawTail.slice(-500).replace(/\n/g, '\\n')}`);
  }
  if (ok) success('OpenAI:chat', 'Streaming parse OK');
  else error('OpenAI:chat', 'Streaming parse FAILED');
  return ok;
}

async function testResponsesNonStreaming(apiKey: string): Promise<boolean> {
  log('OpenAI:responses', 'Non-streaming: hitting real /v1/responses...');

  const res = await fetchJson(OPENAI_RESPONSES_URL, apiKey, {
    model: RESPONSES_MODEL,
    input: 'Reply with the single word: pong.',
    max_output_tokens: 20,
  });

  if (!res.ok) {
    error('OpenAI:responses', `Non-streaming HTTP ${res.status}: ${await res.text()}`);
    return false;
  }

  const body = await res.text();
  console.log(`    body bytes: ${body.length}`);
  const parsedRes = JSON.parse(body) as {
    id?: string;
    model?: string;
    object?: string;
    created_at?: number;
    status?: string;
    usage?: OpenAIResponsesUsage;
  };
  console.log(`    OpenAI reported usage: ${JSON.stringify(parsedRes.usage)}`);
  console.log(`    OpenAI status: ${parsedRes.status}, object: ${parsedRes.object}`);

  const parsed = parseTokenUsage(body, 'openai');
  console.log(`    parser tokens: ${JSON.stringify(parsed)}`);

  const metadata = extractMetadataFromResponseBody(body);
  console.log(`    parser metadata: ${JSON.stringify(metadata)}`);

  const tokenChecks = assertTokens(parsed, parsedRes.usage);
  const metadataChecks = assertMetadata(metadata, {
    expectId: true,
    expectModel: RESPONSES_MODEL,
    expectObject: 'response',
    // Responses API uses `created_at`; parser now falls back to it.
    expectCreated: true,
    // Responses API maps top-level `status` ("completed") to finishReason.
    expectFinishReason: /^(completed|failed|incomplete|cancelled)$/,
  });

  const ok = tokenChecks.ok && metadataChecks.ok;
  if (ok) success('OpenAI:responses', 'Non-streaming parse OK');
  else error('OpenAI:responses', 'Non-streaming parse FAILED');
  return ok;
}

async function testResponsesStreaming(apiKey: string): Promise<boolean> {
  log('OpenAI:responses', 'Streaming: hitting real /v1/responses (SSE)...');

  const res = await fetchSSE(OPENAI_RESPONSES_URL, apiKey, {
    model: RESPONSES_MODEL,
    input: 'Count from 1 to 5, one number per line.',
    max_output_tokens: 80,
    stream: true,
  });

  if (!res.ok || !res.body) {
    error('OpenAI:responses', `Streaming HTTP ${res.status}: ${res.statusText}`);
    return false;
  }

  const { streamData, rawTail, totalBytes } = await readStreamToData(res);
  console.log(`    stream bytes: ${totalBytes}, parsed messages: ${streamData.messages.length}`);
  const lastMessage = streamData.messages[streamData.messages.length - 1];
  console.log(`    event types seen: ${lastMessage?.events.map((e) => e.type).join(', ')}`);
  console.log(`    last message metadata: ${JSON.stringify(lastMessage?.metadata)}`);
  console.log(`    last message usage (raw): ${JSON.stringify(lastMessage?.usage)}`);

  const aggregated = aggregateSSETokens(streamData);
  console.log(`    aggregated tokens: ${JSON.stringify(aggregated)}`);

  // Find the response.completed event and extract OpenAI's reported usage from it
  const completedEvent = lastMessage?.events.find((e) => e.type === 'response.completed');
  let upstreamUsage: OpenAIResponsesUsage | undefined;
  if (completedEvent?.data) {
    try {
      const parsed = JSON.parse(completedEvent.data) as {
        response?: { usage?: OpenAIResponsesUsage };
      };
      upstreamUsage = parsed.response?.usage;
    } catch {
      // ignore
    }
  }
  console.log(`    upstream usage from response.completed: ${JSON.stringify(upstreamUsage)}`);

  const tokenChecks = assertTokens(aggregated, upstreamUsage);
  const metadataChecks = assertMetadata(lastMessage?.metadata ?? {}, {
    expectId: true,
    expectModel: RESPONSES_MODEL,
    expectObject: 'response',
    expectCreated: true,
    expectFinishReason: /^(completed|failed|incomplete|cancelled)$/,
  });

  // TTFT needs at least one content-emitting delta. traces.ts now accepts
  // content_block_delta (Chat-style) or response.output_text.delta (Responses API).
  const failures: string[] = [];
  const hasTtftDelta =
    !!lastMessage?.events &&
    lastMessage.events.some(
      (e) => e.type === 'content_block_delta' || e.type === 'response.output_text.delta',
    );
  check(
    failures,
    'TTFT-eligible delta event present (content_block_delta or response.output_text.delta)',
    hasTtftDelta,
    `found: ${hasTtftDelta}`,
  );

  const ok = tokenChecks.ok && metadataChecks.ok && failures.length === 0;
  if (!ok) {
    console.log('    last 800 bytes of stream:');
    console.log(`    ${rawTail.slice(-800).replace(/\n/g, '\\n')}`);
  }
  if (ok) success('OpenAI:responses', 'Streaming parse OK');
  else error('OpenAI:responses', 'Streaming parse FAILED');
  return ok;
}

async function testChatToolCalls(apiKey: string): Promise<boolean> {
  log('OpenAI:tools', 'Non-streaming with tool call: /v1/chat/completions...');

  const requestBody = {
    model: CHAT_MODEL,
    messages: [{ role: 'user' as const, content: 'What is the weather in Tokyo? Use the tool.' }],
    tools: [
      {
        type: 'function' as const,
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      },
    ],
    tool_choice: 'auto' as const,
    max_tokens: 80,
  };
  const res = await fetchJson(OPENAI_CHAT_URL, apiKey, requestBody);

  if (!res.ok) {
    error('OpenAI:tools', `HTTP ${res.status}: ${await res.text()}`);
    return false;
  }
  const body = await res.text();
  const parsedRes = JSON.parse(body) as {
    choices?: { message?: { tool_calls?: { id: string; function: { name: string } }[] } }[];
    usage?: OpenAIChatUsage;
  };
  const toolCall = parsedRes.choices?.[0]?.message?.tool_calls?.[0];
  console.log(`    upstream tool_call: ${JSON.stringify(toolCall)}`);

  const parsed = parseTokenUsage(body, 'openai');
  const metadata = extractMetadataFromResponseBody(body);
  console.log(`    parser tokens: ${JSON.stringify(parsed)}`);
  console.log(`    parser metadata.finishReason: ${metadata?.finishReason}`);

  // Request body should be parsed back into structured InputMessages.
  // Then feed THAT request plus a follow-up tool message into the parser
  // to verify tool_calls + tool_result roundtripping.
  const followupBody = JSON.stringify({
    ...requestBody,
    messages: [
      ...requestBody.messages,
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: toolCall
          ? [{ id: toolCall.id, type: 'function', function: toolCall.function }]
          : [],
      },
      {
        role: 'tool' as const,
        tool_call_id: toolCall?.id ?? 'unknown',
        content: '{"temp":18,"unit":"C"}',
      },
    ],
  });
  const inputMessages = parseOpenAIStyleRequestBody(followupBody);
  console.log(`    parser inputMessages: ${JSON.stringify(inputMessages)}`);

  const failures: string[] = [];
  check(
    failures,
    'metadata.finishReason is tool_calls',
    metadata?.finishReason === 'tool_calls',
    metadata?.finishReason ?? '<missing>',
  );
  check(failures, 'tokens parsed', !!parsed?.totalTokens, String(parsed?.totalTokens));

  // Verify InputMessages roundtrip carries tool_call + tool_result
  const hasToolCallBlock = !!inputMessages?.some((m) =>
    m.contentBlocks.some((b) => b.type === 'tool_call' && !!b.toolUseId),
  );
  check(
    failures,
    'inputMessages has tool_call block with toolUseId',
    hasToolCallBlock,
    String(hasToolCallBlock),
  );

  const hasToolResultBlock = !!inputMessages?.some((m) =>
    m.contentBlocks.some((b) => b.type === 'tool_result' && !!b.toolCallId),
  );
  check(
    failures,
    'inputMessages has tool_result block with toolCallId',
    hasToolResultBlock,
    String(hasToolResultBlock),
  );

  const ok = failures.length === 0;
  if (ok) success('OpenAI:tools', 'Tool-call parse OK');
  else error('OpenAI:tools', 'Tool-call parse FAILED');
  return ok;
}

async function main() {
  console.log('='.repeat(64));
  console.log('OpenAI LIVE Parser Integration Test');
  console.log(`Chat Completions model: ${CHAT_MODEL}`);
  console.log(`Responses API model:    ${RESPONSES_MODEL}`);
  console.log('='.repeat(64));

  const apiKey = requireEnv('OPENAI_API_KEY');

  // Run sequentially so logs stay grouped per-test; failures still reported.
  const results: { name: string; ok: boolean }[] = [];
  for (const [name, fn] of [
    ['chat non-streaming', () => testChatNonStreaming(apiKey)],
    ['chat streaming', () => testChatStreaming(apiKey)],
    ['responses non-streaming', () => testResponsesNonStreaming(apiKey)],
    ['responses streaming', () => testResponsesStreaming(apiKey)],
    ['chat tool calls', () => testChatToolCalls(apiKey)],
  ] as const) {
    console.log();
    console.log('-'.repeat(64));
    try {
      results.push({ name, ok: await fn() });
    } catch (e) {
      error(name, e instanceof Error ? e.message : String(e));
      results.push({ name, ok: false });
    }
  }

  console.log();
  console.log('='.repeat(64));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
  }
  const allPassed = results.every((r) => r.ok);
  console.log(allPassed ? '✓ ALL PARSER CHECKS PASSED' : '✗ PARSER CHECKS FAILED');
  console.log('='.repeat(64));
  process.exit(allPassed ? 0 : 1);
}

void main();
