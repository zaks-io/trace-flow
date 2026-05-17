import { generateText, streamText } from 'ai';
import type { LanguageModel, LanguageModelUsage, SystemModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { Scenario, ScenarioContext } from './types';
import type { RequestResult, ScenarioResult } from '../output';
import { PROXY_URL, getProxyHeaders } from '../config';
import { formatBaggage, formatTraceparent, generateSpanId } from '../trace';

const MODEL_ID = 'gpt-4.1-mini';

// ~1,400 tokens — exceeds OpenAI's 1,024-token auto-cache threshold.
const CACHE_SYSTEM_PARAGRAPH = `You are an expert software architect specializing in distributed systems, microservices, and cloud-native applications. Your deep expertise spans event-driven architectures, domain-driven design, CQRS and event sourcing patterns, service mesh implementations, and observability platforms. You understand the tradeoffs between consistency and availability in distributed systems, and you can reason about failure modes, retry strategies, circuit breakers, bulkheads, and graceful degradation. When analyzing code or architecture, consider performance implications, security boundaries, data sovereignty requirements, and operational complexity. You should evaluate solutions against the CAP theorem, understand consensus algorithms like Raft and Paxos, and be familiar with distributed transaction patterns including sagas and two-phase commits. Your recommendations should account for team size, organizational structure following Conway's Law, and the evolutionary architecture principles that allow systems to adapt over time without requiring complete rewrites.`;

function buildLargeSystemPrompt(): string {
  return Array(8).fill(CACHE_SYSTEM_PARAGRAPH).join('\n\n');
}

function createResponsesModel(apiKey: string): LanguageModel {
  return createOpenAI({
    baseURL: `${PROXY_URL}/openai/v1`,
    apiKey,
    headers: getProxyHeaders(),
  }).responses(MODEL_ID);
}

function buildHeaders(
  traceId: string,
  operation: string,
): { headers: Record<string, string>; spanId: string } {
  const spanId = generateSpanId();
  return {
    headers: {
      traceparent: formatTraceparent(traceId, spanId),
      baggage: formatBaggage({ operation, user_id: 'test-user-responses' }),
    },
    spanId,
  };
}

function describeUsage(usage: LanguageModelUsage | undefined): string {
  if (!usage) return 'usage=undefined';
  const cache = usage.inputTokenDetails?.cacheReadTokens;
  return `input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens} cache_read=${cache ?? 'n/a'}`;
}

async function runNonStreaming(model: LanguageModel, traceId: string): Promise<RequestResult> {
  const { headers, spanId } = buildHeaders(traceId, 'non-streaming');
  const start = Date.now();
  try {
    const result = await generateText({
      model,
      prompt: 'Reply with a single word: ready.',
      maxOutputTokens: 20,
      headers,
    });
    const usage = result.usage;
    const ok =
      typeof usage.inputTokens === 'number' &&
      usage.inputTokens > 0 &&
      typeof usage.outputTokens === 'number' &&
      usage.outputTokens > 0;
    return {
      provider: 'OpenAI (Responses API)',
      providerId: 'openai-responses',
      scenario: 'responses-api',
      label: 'non-streaming',
      traceId,
      spanId,
      duration: Date.now() - start,
      status: ok ? 'passed' : 'failed',
      text: result.text?.trim(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      error: ok ? undefined : `unexpected usage shape: ${describeUsage(usage)}`,
    };
  } catch (e: unknown) {
    return {
      provider: 'OpenAI (Responses API)',
      providerId: 'openai-responses',
      scenario: 'responses-api',
      label: 'non-streaming',
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runStreaming(
  model: LanguageModel,
  traceId: string,
  label: string,
  options: { system?: string | SystemModelMessage; prompt: string } = {
    prompt: 'Count to three, one number per line.',
  },
): Promise<RequestResult & { rawUsage?: LanguageModelUsage }> {
  const { headers, spanId } = buildHeaders(traceId, label);
  const start = Date.now();
  let ttft: number | undefined;
  try {
    const stream = streamText({
      model,
      system: options.system,
      prompt: options.prompt,
      maxOutputTokens: 80,
      headers,
    });

    let text = '';
    for await (const chunk of stream.textStream) {
      ttft ??= Date.now() - start;
      text += chunk;
    }

    const usage = await stream.usage;
    const ok =
      typeof usage.inputTokens === 'number' &&
      usage.inputTokens > 0 &&
      typeof usage.outputTokens === 'number' &&
      usage.outputTokens > 0;

    return {
      provider: 'OpenAI (Responses API)',
      providerId: 'openai-responses',
      scenario: 'responses-api',
      label,
      traceId,
      spanId,
      duration: Date.now() - start,
      ttft,
      status: ok ? 'passed' : 'failed',
      text: text.trim(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
      error: ok ? undefined : `unexpected usage shape: ${describeUsage(usage)}`,
      rawUsage: usage,
    };
  } catch (e: unknown) {
    return {
      provider: 'OpenAI (Responses API)',
      providerId: 'openai-responses',
      scenario: 'responses-api',
      label,
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const responsesApiScenario: Scenario = {
  id: 'responses-api',
  name: 'OpenAI Responses API',
  description: 'Non-streaming + streaming + cache write/read against /v1/responses',
  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const start = Date.now();
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      const skipped: RequestResult = {
        provider: 'OpenAI (Responses API)',
        providerId: 'openai-responses',
        scenario: 'responses-api',
        duration: 0,
        status: 'skipped',
        error: 'OPENAI_API_KEY not set',
      };
      ctx.onResult?.(skipped);
      return {
        scenario: 'responses-api',
        traceId: ctx.traceId,
        requestCount: 1,
        passed: 0,
        failed: 0,
        skipped: 1,
        results: [skipped],
        duration: Date.now() - start,
      };
    }

    const model = createResponsesModel(apiKey);
    const systemPrompt = buildLargeSystemPrompt();

    const nonStream = await runNonStreaming(model, ctx.traceId);
    ctx.onResult?.(nonStream);

    const stream = await runStreaming(model, ctx.traceId, 'streaming');
    ctx.onResult?.(stream);

    const cacheWrite = await runStreaming(model, ctx.traceId, 'cache-write', {
      system: systemPrompt,
      prompt: 'Summarize the key principles above in one sentence.',
    });
    ctx.onResult?.(cacheWrite);

    const cacheRead = await runStreaming(model, ctx.traceId, 'cache-read', {
      system: systemPrompt,
      prompt: 'Summarize the key principles above in one sentence.',
    });

    // Override pass/fail for cache-read: passing requires cacheReadTokens > 0
    // on the second call. OpenAI auto-caches identical prompts ≥1024 tokens.
    if (cacheRead.status === 'passed') {
      const cacheTokens = cacheRead.cacheReadTokens ?? 0;
      if (cacheTokens === 0) {
        cacheRead.status = 'failed';
        cacheRead.error = `expected cacheReadTokens > 0 on repeated prompt, got ${cacheTokens}`;
      }
    }
    ctx.onResult?.(cacheRead);

    const results = [nonStream, stream, cacheWrite, cacheRead];
    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;

    return {
      scenario: 'responses-api',
      traceId: ctx.traceId,
      requestCount: results.length,
      passed,
      failed,
      skipped,
      results,
      duration: Date.now() - start,
    };
  },
};
