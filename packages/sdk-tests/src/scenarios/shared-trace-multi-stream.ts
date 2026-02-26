import { streamText } from 'ai';
import type { Scenario, ScenarioContext } from './types';
import type { RequestResult } from '../output';
import type { ProviderConfig } from '../providers';
import { formatBaggage, formatTraceparent, generateSpanId, generateTraceId } from '../trace';

interface SharedTraceOptions {
  requests?: number;
  concurrency?: number;
}

export const sharedTraceMultiStreamScenario: Scenario = {
  id: 'shared-trace-multi-stream',
  name: 'Shared Trace Multi-Stream',
  description: 'Multiple concurrent streamed requests sharing one trace ID',
  async run(
    ctx: ScenarioContext,
    opts?: Record<string, unknown>,
  ): Promise<{
    scenario: string;
    traceId: string;
    requestCount: number;
    passed: number;
    failed: number;
    skipped: number;
    results: RequestResult[];
    duration: number;
  }> {
    const options = (opts ?? {}) as SharedTraceOptions;
    const requestCount = options.requests ?? 3;
    const concurrency = options.concurrency ?? requestCount;

    const traceId = ctx.traceId ?? generateTraceId();

    const tasks: {
      config: ProviderConfig;
      index: number;
      label: string;
    }[] = [];

    let idx = 0;
    for (const config of ctx.providerConfigs) {
      const apiKey = process.env[config.envKey];
      if (!apiKey) continue;

      for (let r = 0; r < requestCount; r++) {
        tasks.push({
          config,
          index: idx++,
          label: `${config.id}#${r + 1}`,
        });
      }
    }

    if (tasks.length === 0) {
      return {
        scenario: 'shared-trace-multi-stream',
        traceId,
        requestCount: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        results: [],
        duration: 0,
      };
    }

    const start = Date.now();
    const results = new Array<RequestResult | undefined>(tasks.length);

    async function runOne(task: (typeof tasks)[0]): Promise<RequestResult> {
      const apiKey = process.env[task.config.envKey]!;
      const model = task.config.createModel(apiKey);
      const spanId = generateSpanId();
      const traceparent = formatTraceparent(traceId, spanId);
      const baggage = formatBaggage({ operation: `stream-${task.index + 1}` });

      const reqStart = Date.now();
      let ttft: number | undefined;

      try {
        const result = streamText({
          model,
          prompt: `Request ${task.index + 1}: Say the number ${task.index + 1} in words.`,
          maxOutputTokens: 20,
          headers: { traceparent, baggage },
        });

        let text = '';
        for await (const chunk of result.textStream) {
          ttft ??= Date.now() - reqStart;
          text += chunk;
        }
        const usage = await result.usage;

        return {
          provider: task.config.name,
          providerId: task.config.id,
          scenario: 'shared-trace-multi-stream',
          requestIndex: task.index,
          label: task.label,
          traceId,
          spanId,
          duration: Date.now() - reqStart,
          ttft,
          status: 'passed',
          text: text.trim(),
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
        };
      } catch (e: unknown) {
        return {
          provider: task.config.name,
          providerId: task.config.id,
          scenario: 'shared-trace-multi-stream',
          requestIndex: task.index,
          label: task.label,
          traceId,
          spanId,
          duration: Date.now() - reqStart,
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    const chunks: (typeof tasks)[] = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
      chunks.push(tasks.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const settled = await Promise.allSettled(chunk.map(runOne));
      for (let i = 0; i < chunk.length; i++) {
        const r = settled[i];
        const task = chunk[i]!;
        if (r?.status === 'fulfilled') {
          results[task.index] = r.value;
        } else {
          results[task.index] = {
            provider: task.config.name,
            providerId: task.config.id,
            scenario: 'shared-trace-multi-stream',
            requestIndex: task.index,
            label: task.label,
            traceId,
            spanId: generateSpanId(),
            duration: 0,
            status: 'failed',
            error: r?.reason instanceof Error ? r.reason.message : String(r?.reason),
          };
        }
      }
    }

    const filled = results.filter((r): r is RequestResult => r != null);
    const passed = filled.filter((r) => r.status === 'passed').length;
    const failed = filled.filter((r) => r.status === 'failed').length;
    const skipped = filled.filter((r) => r.status === 'skipped').length;

    return {
      scenario: 'shared-trace-multi-stream',
      traceId,
      requestCount: filled.length,
      passed,
      failed,
      skipped,
      results: filled,
      duration: Date.now() - start,
    };
  },
};
