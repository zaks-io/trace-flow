import { generateText } from 'ai';
import type { SystemModelMessage } from 'ai';
import type { Scenario, ScenarioContext } from './types';
import type { RequestResult, ScenarioResult } from '../output';
import { formatBaggage, formatTraceparent, generateSpanId } from '../trace';

// ~4,100 tokens when tokenized — exceeds Anthropic Haiku 4.5's 4,096 minimum
const SYSTEM_PROMPT_PARAGRAPH = `You are an expert software architect specializing in distributed systems, microservices, and cloud-native applications. Your deep expertise spans event-driven architectures, domain-driven design, CQRS and event sourcing patterns, service mesh implementations, and observability platforms. You understand the tradeoffs between consistency and availability in distributed systems, and you can reason about failure modes, retry strategies, circuit breakers, bulkheads, and graceful degradation. When analyzing code or architecture, consider performance implications, security boundaries, data sovereignty requirements, and operational complexity. You should evaluate solutions against the CAP theorem, understand consensus algorithms like Raft and Paxos, and be familiar with distributed transaction patterns including sagas and two-phase commits. Your recommendations should account for team size, organizational structure following Conway's Law, and the evolutionary architecture principles that allow systems to adapt over time without requiring complete rewrites.`;

function generateLargeSystemPrompt(): string {
  return Array(21).fill(SYSTEM_PROMPT_PARAGRAPH).join('\n\n');
}

function buildSystemMessage(systemPrompt: string, providerId: string): string | SystemModelMessage {
  if (providerId === 'anthropic') {
    return {
      role: 'system',
      content: systemPrompt,
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    };
  }
  return systemPrompt;
}

function extractCacheMetrics(result: Awaited<ReturnType<typeof generateText>>): {
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
} {
  const meta = result.providerMetadata?.anthropic as Record<string, number> | undefined;
  return {
    cacheCreationTokens: meta?.cacheCreationInputTokens ?? undefined,
    cacheReadTokens: meta?.cacheReadInputTokens ?? undefined,
  };
}

export const promptCachingScenario: Scenario = {
  id: 'prompt-caching',
  name: 'Prompt Caching',
  description: 'Sends identical large prompt twice to test cache write then cache read',
  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const results: RequestResult[] = [];
    const start = Date.now();
    const { traceId } = ctx;
    const systemPrompt = generateLargeSystemPrompt();

    for (const config of ctx.providerConfigs) {
      const apiKey = process.env[config.envKey];
      if (!apiKey) {
        const skipped = {
          provider: config.name,
          providerId: config.id,
          scenario: 'prompt-caching',
          duration: 0,
          status: 'skipped' as const,
          error: `${config.envKey} not set`,
        };
        results.push(skipped);
        ctx.onResult?.(skipped);
        continue;
      }

      const model = config.createModel(apiKey);
      const system = buildSystemMessage(systemPrompt, config.id);

      const isAnthropic = config.id === 'anthropic';

      // Request 1: cache write (Anthropic) / large prompt baseline (others)
      const writeResult = await runCacheRequest(
        config,
        model,
        system,
        traceId,
        isAnthropic ? 'cache-write' : 'large-prompt-1',
      );
      results.push(writeResult);
      ctx.onResult?.(writeResult);

      // Request 2: cache read (Anthropic) / large prompt repeat (others)
      const readResult = await runCacheRequest(
        config,
        model,
        system,
        traceId,
        isAnthropic ? 'cache-read' : 'large-prompt-2',
      );
      results.push(readResult);
      ctx.onResult?.(readResult);
    }

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;

    return {
      scenario: 'prompt-caching',
      traceId,
      requestCount: results.length,
      passed,
      failed,
      skipped,
      results,
      duration: Date.now() - start,
    };
  },
};

async function runCacheRequest(
  config: { name: string; id: string },
  model: Parameters<typeof generateText>[0]['model'],
  system: string | SystemModelMessage,
  traceId: string,
  operation: string,
): Promise<RequestResult> {
  const spanId = generateSpanId();
  const traceparent = formatTraceparent(traceId, spanId);
  const baggage = formatBaggage({ operation });
  const start = Date.now();

  try {
    const result = await generateText({
      model,
      system,
      prompt: 'Summarize the key principles above in one sentence.',
      maxOutputTokens: 100,
      headers: { traceparent, baggage },
    });

    const cache = extractCacheMetrics(result);
    return {
      provider: config.name,
      providerId: config.id,
      scenario: 'prompt-caching',
      label: operation,
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'passed',
      text: result.text?.trim(),
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      cacheCreationTokens: cache.cacheCreationTokens,
      cacheReadTokens: cache.cacheReadTokens,
    };
  } catch (e: unknown) {
    return {
      provider: config.name,
      providerId: config.id,
      scenario: 'prompt-caching',
      label: operation,
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
