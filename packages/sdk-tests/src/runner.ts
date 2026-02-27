import type { LanguageModel } from 'ai';
import type { RequestResult } from './output';
import { formatBaggage, formatTraceparent, generateSpanId } from './trace';

export interface RunContext {
  model: LanguageModel;
  providerId: string;
  providerName: string;
  traceId?: string;
  operation?: string;
  headers?: Record<string, string>;
}

export interface BasicScenarioConfig {
  prompt?: string;
  maxTokens?: number;
}

function buildTraceHeaders(ctx: RunContext): {
  headers: Record<string, string>;
  spanId: string | undefined;
} {
  const spanId = ctx.traceId ? generateSpanId() : undefined;
  const headers: Record<string, string> = {
    ...ctx.headers,
    ...(ctx.traceId && spanId ? { traceparent: formatTraceparent(ctx.traceId, spanId) } : {}),
    ...(ctx.operation ? { baggage: formatBaggage({ operation: ctx.operation }) } : {}),
  };
  return { headers, spanId };
}

export async function runNonStreaming(
  ctx: RunContext,
  config: BasicScenarioConfig = {},
): Promise<RequestResult> {
  const { model, providerName, providerId } = ctx;
  const prompt = config.prompt ?? 'Say hello in 3 words.';
  const maxTokens = config.maxTokens ?? 50;
  const { headers, spanId } = buildTraceHeaders(ctx);
  const start = Date.now();

  const { generateText } = await import('ai');
  try {
    const result = await generateText({
      model,
      prompt,
      maxOutputTokens: maxTokens,
      headers,
    });
    const duration = Date.now() - start;
    return {
      provider: providerName,
      providerId,
      scenario: 'basic-non-streaming',
      traceId: ctx.traceId,
      spanId,
      duration,
      status: 'passed',
      text: result.text?.trim(),
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    };
  } catch (e: unknown) {
    return {
      provider: providerName,
      providerId,
      scenario: 'basic-non-streaming',
      traceId: ctx.traceId,
      spanId,
      duration: Date.now() - start,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runStreaming(
  ctx: RunContext,
  config: BasicScenarioConfig = {},
): Promise<RequestResult> {
  const { model, providerName, providerId } = ctx;
  const prompt = config.prompt ?? 'Count to 3.';
  const maxTokens = config.maxTokens ?? 50;
  const { headers, spanId } = buildTraceHeaders(ctx);
  const start = Date.now();
  let ttft: number | undefined;

  const { streamText } = await import('ai');
  try {
    const result = streamText({
      model,
      prompt,
      maxOutputTokens: maxTokens,
      headers,
    });

    let text = '';
    for await (const chunk of result.textStream) {
      ttft ??= Date.now() - start;
      text += chunk;
    }
    const usage = await result.usage;
    const duration = Date.now() - start;
    return {
      provider: providerName,
      providerId,
      scenario: 'basic-streaming',
      traceId: ctx.traceId,
      spanId,
      duration,
      ttft,
      status: 'passed',
      text: text.trim(),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    };
  } catch (e: unknown) {
    return {
      provider: providerName,
      providerId,
      scenario: 'basic-streaming',
      traceId: ctx.traceId,
      spanId,
      duration: Date.now() - start,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
