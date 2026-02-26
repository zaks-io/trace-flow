import type { Scenario, ScenarioContext } from './types';
import type { ScenarioResult } from '../output';
import { runNonStreaming, runStreaming } from '../runner';

export const basicScenario: Scenario = {
  id: 'basic',
  name: 'Basic',
  description: 'Non-streaming + streaming requests',
  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const results: ScenarioResult['results'] = [];
    const start = Date.now();

    for (const config of ctx.providerConfigs) {
      const apiKey = process.env[config.envKey];
      if (!apiKey) {
        results.push({
          provider: config.name,
          providerId: config.id,
          scenario: 'basic',
          duration: 0,
          status: 'skipped',
          error: `${config.envKey} not set`,
        });
        continue;
      }

      const model = config.createModel(apiKey);
      const base = {
        model,
        providerId: config.id,
        providerName: config.name,
        traceId: ctx.traceId,
      };

      const [nonStream, stream] = await Promise.all([
        runNonStreaming({ ...base, operation: 'non-streaming' }),
        runStreaming({ ...base, operation: 'streaming' }),
      ]);
      nonStream.label = 'non-streaming';
      stream.label = 'streaming';
      results.push(nonStream, stream);
    }

    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;

    return {
      scenario: 'basic',
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
