/**
 * Node-only guard for Tinybird JWT mintable pipes. Run via:
 *   bun scripts/verify-tinybird-jwt-allowlist.ts
 *
 * Lives outside packages/convex so Convex preview deploy never bundles node:fs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_TINYBIRD_PIPE_RESOURCES,
  assertMintableTinybirdScopes,
  TINYBIRD_PIPES_READ_SCOPE,
} from '../packages/convex/integrations/tinybirdScopes';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIPES_DIR = join(REPO_ROOT, 'pipes');

function listShippedPipes(): string[] {
  return readdirSync(PIPES_DIR)
    .filter((name) => name.endsWith('.pipe'))
    .map((name) => name.slice(0, -'.pipe'.length))
    .sort();
}

function assertRowSecuredEndpointPipe(pipeName: string): void {
  const content = readFileSync(join(PIPES_DIR, `${pipeName}.pipe`), 'utf8');

  if (!content.includes('TYPE ENDPOINT')) {
    throw new Error(`${pipeName} must be TYPE ENDPOINT to be JWT-mintable`);
  }

  const hasRowSecurity = content.includes('String(api_keys') || content.includes('String(org_id');
  if (!hasRowSecurity) {
    throw new Error(`${pipeName} must filter on api_keys or org_id fixed_params`);
  }
}

function main(): void {
  for (const pipe of ALLOWED_TINYBIRD_PIPE_RESOURCES) {
    assertRowSecuredEndpointPipe(pipe);
  }

  if (ALLOWED_TINYBIRD_PIPE_RESOURCES.has('agent_priced_usage')) {
    throw new Error('agent_priced_usage must not be JWT-mintable');
  }

  try {
    assertRowSecuredEndpointPipe('agent_priced_usage');
    throw new Error('agent_priced_usage must fail row-security validation');
  } catch (error) {
    if (!(error instanceof Error) || !/TYPE ENDPOINT/i.test(error.message)) {
      throw error;
    }
  }

  try {
    assertMintableTinybirdScopes([
      { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'agent_priced_usage' },
    ]);
    throw new Error('generateToken must reject agent_priced_usage');
  } catch (error) {
    if (!(error instanceof Error) || !/pipe not allowed/i.test(error.message)) {
      throw error;
    }
  }

  if (!ALLOWED_TINYBIRD_PIPE_RESOURCES.has('agent_context_health')) {
    throw new Error('agent_context_health must remain JWT-mintable');
  }

  const shippedPipes = listShippedPipes();
  const allowlistedPipes = [...ALLOWED_TINYBIRD_PIPE_RESOURCES].sort();
  if (shippedPipes.length <= allowlistedPipes.length) {
    throw new Error('shipped pipes inventory must be larger than JWT allowlist');
  }
  for (const pipe of allowlistedPipes) {
    if (!shippedPipes.includes(pipe)) {
      throw new Error(`allowlisted pipe missing from pipes/: ${pipe}`);
    }
  }

  console.log(
    `Tinybird JWT allowlist OK (${allowlistedPipes.length} mintable pipes, ${shippedPipes.length} shipped)`,
  );
}

main();
