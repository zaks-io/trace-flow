import type { ScenarioResult } from '../output';
import type { ProviderConfig } from '../providers';

export interface ScenarioContext {
  providerConfigs: ProviderConfig[];
  proxyUrl: string;
  jsonMode: boolean;
  traceId: string;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  run: (ctx: ScenarioContext, options?: Record<string, unknown>) => Promise<ScenarioResult>;
}
