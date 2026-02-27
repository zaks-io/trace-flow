import type { RequestResult, ScenarioResult } from '../output';
import type { ProviderConfig } from '../providers';

export interface ScenarioContext {
  providerConfigs: ProviderConfig[];
  proxyUrl: string;
  jsonMode: boolean;
  traceId: string;
  onResult?: (result: RequestResult) => void;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  run: (ctx: ScenarioContext, options?: Record<string, unknown>) => Promise<ScenarioResult>;
}
