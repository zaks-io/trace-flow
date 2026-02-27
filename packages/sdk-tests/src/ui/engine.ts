import { EventEmitter } from 'events';
import type { RequestResult, ScenarioResult } from '../output';
import type { Scenario, ScenarioContext } from '../scenarios/types';
import type { ProviderConfig } from '../providers';

export interface RunParams {
  scenario: Scenario;
  providerConfigs: ProviderConfig[];
  proxyUrl: string;
  traceId: string;
  scenarioOpts?: Record<string, unknown>;
}

export interface ProviderInfo {
  id: string;
  name: string;
  model: string;
}

export type EngineEvent =
  | { type: 'run:start'; scenario: string; providers: ProviderInfo[]; traceId: string }
  | { type: 'result:complete'; result: RequestResult }
  | { type: 'run:done'; result: ScenarioResult }
  | { type: 'run:error'; error: Error };

export class TestEngine extends EventEmitter<{
  'run:start': [{ scenario: string; providers: ProviderInfo[]; traceId: string }];
  'result:complete': [{ result: RequestResult }];
  'run:done': [{ result: ScenarioResult }];
  'run:error': [{ error: Error }];
}> {
  async run(params: RunParams): Promise<ScenarioResult> {
    const { scenario, providerConfigs, proxyUrl, traceId, scenarioOpts } = params;

    this.emit('run:start', {
      scenario: scenario.id,
      providers: providerConfigs.map((p) => ({ id: p.id, name: p.name, model: p.model })),
      traceId,
    });

    const ctx: ScenarioContext = {
      providerConfigs,
      proxyUrl,
      jsonMode: false,
      traceId,
      onResult: (result) => {
        this.emit('result:complete', { result });
      },
    };

    try {
      const result = await scenario.run(ctx, scenarioOpts);
      this.emit('run:done', { result });
      return result;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.emit('run:error', { error });
      throw error;
    }
  }
}
