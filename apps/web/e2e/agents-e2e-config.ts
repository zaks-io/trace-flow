import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultAgentsStorageState = resolve(repoRoot, '.trace-flow/agents-e2e-storage-state.json');
export const agentsStorageStatePath =
  process.env.TRACE_FLOW_AGENTS_E2E_STORAGE_STATE ?? defaultAgentsStorageState;

export const agentsE2eBaseUrl =
  process.env.TRACE_FLOW_AGENTS_E2E_BASE_URL ?? 'http://localhost:3000';
export const agentsStorageState = existsSync(agentsStorageStatePath)
  ? agentsStorageStatePath
  : undefined;
export const agentsStorageStateSkipReason = process.env.TRACE_FLOW_AGENTS_E2E_STORAGE_STATE
  ? `No Playwright auth state found at ${agentsStorageStatePath}.`
  : 'Run `bun run test:e2e:agents:auth` to save an authenticated browser session.';
