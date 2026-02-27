import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import type { Scenario, ScenarioContext } from './types';
import type { RequestResult } from '../output';
import { formatBaggage, formatTraceparent, generateSpanId } from '../trace';

export const toolsScenario: Scenario = {
  id: 'tools',
  name: 'Tools',
  description: 'Tool-calling with streamText',
  async run(ctx: ScenarioContext): Promise<{
    scenario: string;
    traceId: string;
    requestCount: number;
    passed: number;
    failed: number;
    skipped: number;
    results: RequestResult[];
    duration: number;
  }> {
    const results: RequestResult[] = [];
    const start = Date.now();

    for (const config of ctx.providerConfigs) {
      const apiKey = process.env[config.envKey];
      if (!apiKey) {
        const skipped = {
          provider: config.name,
          providerId: config.id,
          scenario: 'tools',
          duration: 0,
          status: 'skipped' as const,
          error: `${config.envKey} not set`,
        };
        results.push(skipped);
        ctx.onResult?.(skipped);
        continue;
      }

      const model = config.createModel(apiKey);
      const spanId = generateSpanId();
      const traceparent = formatTraceparent(ctx.traceId, spanId);
      const baggage = formatBaggage({ operation: 'tool-call' });
      const reqStart = Date.now();

      try {
        const stream = streamText({
          model,
          system:
            'You are a helpful assistant. When asked for the current time, use the getCurrentTime tool and return the result.',
          prompt: 'What is the current time?',
          tools: {
            getCurrentTime: tool({
              description: 'Get the current time',
              inputSchema: z.object({ timezone: z.string().optional().describe('IANA timezone') }),
              execute: () => new Date().toISOString(),
            }),
          },
          toolChoice: 'required',
          stopWhen: stepCountIs(2),
          headers: { traceparent, baggage },
        });
        const text = await stream.text;
        const steps = await stream.steps;
        const usage = await stream.usage;
        const duration = Date.now() - reqStart;
        const reqResult: RequestResult = {
          provider: config.name,
          providerId: config.id,
          scenario: 'tools',
          traceId: ctx.traceId,
          spanId,
          duration,
          status: 'passed',
          text: text?.trim(),
          label: `tools (${steps.flatMap((s) => s.toolCalls).length} calls)`,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          debug: ctx.jsonMode
            ? {
                stepCount: steps.length,
                steps: steps.map((s, i) => ({
                  step: i,
                  text: s.text,
                  toolCalls: s.toolCalls.map((tc) => ({
                    name: tc.toolName,
                    input: tc.input,
                  })),
                  toolResults: s.toolResults.map((tr) => ({
                    name: tr.toolName,
                    output: tr.output,
                  })),
                  usage: s.usage,
                })),
              }
            : undefined,
        };
        results.push(reqResult);
        ctx.onResult?.(reqResult);
      } catch (e: unknown) {
        const reqResult: RequestResult = {
          provider: config.name,
          providerId: config.id,
          scenario: 'tools',
          traceId: ctx.traceId,
          spanId,
          duration: Date.now() - reqStart,
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
        };
        results.push(reqResult);
        ctx.onResult?.(reqResult);
      }
    }

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;

    return {
      scenario: 'tools',
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
