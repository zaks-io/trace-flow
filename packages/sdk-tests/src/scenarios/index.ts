import type { Scenario } from './types';
import { basicScenario } from './basic';
import { comprehensiveScenario } from './comprehensive';
import { promptCachingScenario } from './prompt-caching';
import { sharedTraceMultiStreamScenario } from './shared-trace-multi-stream';
import { toolsScenario } from './tools';

export type { Scenario, ScenarioContext } from './types';

export const scenarios: Scenario[] = [
  basicScenario,
  toolsScenario,
  sharedTraceMultiStreamScenario,
  promptCachingScenario,
  comprehensiveScenario,
];

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}

export function getAllScenarios(): Scenario[] {
  return scenarios;
}
