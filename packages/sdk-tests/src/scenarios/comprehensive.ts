import { generateText, stepCountIs, streamText, tool } from 'ai';
import type { SystemModelMessage } from 'ai';
import { z } from 'zod';
import type { Scenario, ScenarioContext } from './types';
import type { RequestResult, ScenarioResult } from '../output';
import { formatBaggage, formatTraceparent, generateSpanId } from '../trace';

/**
 * Runs every request type (non-streaming, streaming, tool-calling, concurrent multi-stream)
 * under a single shared traceId so the full suite appears as one bundle in Trace Flow.
 */
export const comprehensiveScenario: Scenario = {
  id: 'comprehensive',
  name: 'Comprehensive',
  description:
    'Non-streaming, streaming, tools, concurrent multi-stream, and prompt caching in one trace',
  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const results: RequestResult[] = [];
    const start = Date.now();
    const { traceId } = ctx;

    for (const config of ctx.providerConfigs) {
      const apiKey = process.env[config.envKey];
      if (!apiKey) {
        const skipped = {
          provider: config.name,
          providerId: config.id,
          scenario: 'comprehensive',
          duration: 0,
          status: 'skipped' as const,
          error: `${config.envKey} not set`,
        };
        results.push(skipped);
        ctx.onResult?.(skipped);
        continue;
      }

      const model = config.createModel(apiKey);

      // --- Phase 1: Non-streaming ---
      const nonStreamResult = await runNonStreamingPhase(config, model, traceId);
      results.push(nonStreamResult);
      ctx.onResult?.(nonStreamResult);

      // --- Phase 2: Streaming ---
      const streamResult = await runStreamingPhase(config, model, traceId);
      results.push(streamResult);
      ctx.onResult?.(streamResult);

      // --- Phase 3: Tool call ---
      const toolResult = await runToolPhase(config, model, traceId);
      results.push(toolResult);
      ctx.onResult?.(toolResult);

      // --- Phase 4: Concurrent multi-stream (3 parallel requests) ---
      const concurrentResults = await runConcurrentPhase(config, model, traceId, 3);
      for (const r of concurrentResults) ctx.onResult?.(r);
      results.push(...concurrentResults);

      // --- Phase 5: Prompt caching (write then read) ---
      const cacheResults = await runPromptCachingPhase(config, model, traceId);
      for (const r of cacheResults) ctx.onResult?.(r);
      results.push(...cacheResults);
    }

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;

    return {
      scenario: 'comprehensive',
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

interface ProviderRef {
  name: string;
  id: string;
}

function makeHeaders(
  traceId: string,
  operation: string,
  userId = 'test-user-1',
): { traceparent: string; baggage: string; spanId: string } {
  const spanId = generateSpanId();
  return {
    traceparent: formatTraceparent(traceId, spanId),
    baggage: formatBaggage({ operation, userId }),
    spanId,
  };
}

async function runNonStreamingPhase(
  config: ProviderRef,
  model: Parameters<typeof generateText>[0]['model'],
  traceId: string,
): Promise<RequestResult> {
  const { traceparent, baggage, spanId } = makeHeaders(traceId, 'non-streaming');
  const start = Date.now();

  try {
    const result = await generateText({
      model,
      prompt: 'Say hello in 3 words.',
      maxOutputTokens: 50,
      headers: { traceparent, baggage },
    });
    return {
      provider: config.name,
      providerId: config.id,
      scenario: 'comprehensive',
      label: 'non-streaming',
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'passed',
      text: result.text?.trim(),
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    };
  } catch (e: unknown) {
    return {
      provider: config.name,
      providerId: config.id,
      scenario: 'comprehensive',
      label: 'non-streaming',
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runStreamingPhase(
  config: ProviderRef,
  model: Parameters<typeof streamText>[0]['model'],
  traceId: string,
): Promise<RequestResult> {
  const { traceparent, baggage, spanId } = makeHeaders(traceId, 'streaming');
  const start = Date.now();
  let ttft: number | undefined;

  try {
    const result = streamText({
      model,
      prompt: 'Count to 5.',
      maxOutputTokens: 50,
      headers: { traceparent, baggage },
    });

    let text = '';
    for await (const chunk of result.textStream) {
      ttft ??= Date.now() - start;
      text += chunk;
    }
    const usage = await result.usage;
    return {
      provider: config.name,
      providerId: config.id,
      scenario: 'comprehensive',
      label: 'streaming',
      traceId,
      spanId,
      duration: Date.now() - start,
      ttft,
      status: 'passed',
      text: text.trim(),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    };
  } catch (e: unknown) {
    return {
      provider: config.name,
      providerId: config.id,
      scenario: 'comprehensive',
      label: 'streaming',
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runToolPhase(
  config: ProviderRef,
  model: Parameters<typeof streamText>[0]['model'],
  traceId: string,
): Promise<RequestResult> {
  const { traceparent, baggage, spanId } = makeHeaders(traceId, 'tool-call');
  const start = Date.now();

  try {
    const result = streamText({
      model,
      system:
        'You are a helpful assistant. When asked for the current time, use the getCurrentTime tool and return the result.',
      prompt: 'What is the current time?',
      tools: {
        getCurrentTime: tool({
          description: 'Get the current time',
          inputSchema: z.object({ timezone: z.string().optional().describe('IANA timezone') }),
          execute: ({ timezone }) =>
            new Intl.DateTimeFormat('en-US', {
              dateStyle: 'full',
              timeStyle: 'long',
              timeZone: timezone ?? 'UTC',
            }).format(new Date()),
        }),
      },
      toolChoice: 'required',
      stopWhen: stepCountIs(2),
      headers: { traceparent, baggage },
    });

    const text = await result.text;
    const steps = await result.steps;
    const usage = await result.usage;
    const toolCalls = steps.flatMap((s) => s.toolCalls).length;
    return {
      provider: config.name,
      providerId: config.id,
      scenario: 'comprehensive',
      label: `tool-call (${toolCalls} calls)`,
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'passed',
      text: text?.trim(),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    };
  } catch (e: unknown) {
    return {
      provider: config.name,
      providerId: config.id,
      scenario: 'comprehensive',
      label: 'tool-call',
      traceId,
      spanId,
      duration: Date.now() - start,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runConcurrentPhase(
  config: ProviderRef,
  model: Parameters<typeof streamText>[0]['model'],
  traceId: string,
  count: number,
): Promise<RequestResult[]> {
  const tasks = Array.from({ length: count }, (_, i) => {
    const { traceparent, baggage, spanId } = makeHeaders(
      traceId,
      `concurrent-stream-${i + 1}`,
      `test-user-${(i % 3) + 1}`,
    );
    const start = Date.now();
    let ttft: number | undefined;

    return (async (): Promise<RequestResult> => {
      try {
        const result = streamText({
          model,
          prompt: `Request ${i + 1}: Say the number ${i + 1} in words.`,
          maxOutputTokens: 20,
          headers: { traceparent, baggage },
        });

        let text = '';
        for await (const chunk of result.textStream) {
          ttft ??= Date.now() - start;
          text += chunk;
        }
        const usage = await result.usage;
        return {
          provider: config.name,
          providerId: config.id,
          scenario: 'comprehensive',
          label: `concurrent-stream-${i + 1}`,
          traceId,
          spanId,
          duration: Date.now() - start,
          ttft,
          status: 'passed',
          text: text.trim(),
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
        };
      } catch (e: unknown) {
        return {
          provider: config.name,
          providerId: config.id,
          scenario: 'comprehensive',
          label: `concurrent-stream-${i + 1}`,
          traceId,
          spanId,
          duration: Date.now() - start,
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
        };
      }
    })();
  });

  return Promise.all(tasks);
}

// --- Prompt Caching ---

const CACHE_SYSTEM_PARAGRAPH = `You are an expert software architect specializing in distributed systems, microservices, and cloud-native applications. Your deep expertise spans event-driven architectures, domain-driven design, CQRS and event sourcing patterns, service mesh implementations, and observability platforms. You understand the tradeoffs between consistency and availability in distributed systems, and you can reason about failure modes, retry strategies, circuit breakers, bulkheads, and graceful degradation. When analyzing code or architecture, consider performance implications, security boundaries, data sovereignty requirements, and operational complexity. You should evaluate solutions against the CAP theorem, understand consensus algorithms like Raft and Paxos, and be familiar with distributed transaction patterns including sagas and two-phase commits. Your recommendations should account for team size, organizational structure following Conway's Law, and the evolutionary architecture principles that allow systems to adapt over time without requiring complete rewrites.`;

function buildCacheSystemMessage(
  systemPrompt: string,
  providerId: string,
): string | SystemModelMessage {
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

async function runPromptCachingPhase(
  config: ProviderRef,
  model: Parameters<typeof generateText>[0]['model'],
  traceId: string,
): Promise<RequestResult[]> {
  const systemPrompt = Array(21).fill(CACHE_SYSTEM_PARAGRAPH).join('\n\n');
  const system = buildCacheSystemMessage(systemPrompt, config.id);

  const runOne = async (operation: string): Promise<RequestResult> => {
    const { traceparent, baggage, spanId } = makeHeaders(traceId, operation);
    const start = Date.now();

    try {
      const result = await generateText({
        model,
        system,
        prompt: 'Summarize the key principles above in one sentence.',
        maxOutputTokens: 100,
        headers: { traceparent, baggage },
      });

      const meta = result.providerMetadata?.anthropic as Record<string, number> | undefined;
      return {
        provider: config.name,
        providerId: config.id,
        scenario: 'comprehensive',
        label: operation,
        traceId,
        spanId,
        duration: Date.now() - start,
        status: 'passed',
        text: result.text?.trim(),
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        cacheCreationTokens: meta?.cacheCreationInputTokens ?? undefined,
        cacheReadTokens: meta?.cacheReadInputTokens ?? undefined,
      };
    } catch (e: unknown) {
      return {
        provider: config.name,
        providerId: config.id,
        scenario: 'comprehensive',
        label: operation,
        traceId,
        spanId,
        duration: Date.now() - start,
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };

  // Sequential: write must complete before read to populate the cache
  const isAnthropicProvider = config.id === 'anthropic';
  const writeResult = await runOne(isAnthropicProvider ? 'cache-write' : 'large-prompt-1');
  const readResult = await runOne(isAnthropicProvider ? 'cache-read' : 'large-prompt-2');
  return [writeResult, readResult];
}
