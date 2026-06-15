/**
 * Pipe-file guards for Tinybird JWT allowlist. Lives outside `packages/convex` so
 * Convex deploy does not bundle Node fs/path APIs from test helpers.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TINYBIRD_PIPE_RESOURCES,
  assertMintableTinybirdScopes,
  TINYBIRD_PIPES_READ_SCOPE,
} from '../packages/convex/integrations/tinybirdScopes';

const REPO_ROOT = join(__dirname, '..');
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

describe('Tinybird JWT mintable pipe inventory', () => {
  it('every JWT-mintable pipe is TYPE ENDPOINT with api_keys or org_id filter', () => {
    for (const pipe of ALLOWED_TINYBIRD_PIPE_RESOURCES) {
      expect(() => assertRowSecuredEndpointPipe(pipe)).not.toThrow();
    }
  });

  it('shipped helper pipes are not JWT-mintable', () => {
    expect(ALLOWED_TINYBIRD_PIPE_RESOURCES.has('agent_priced_usage')).toBe(false);
    expect(() => assertRowSecuredEndpointPipe('agent_priced_usage')).toThrow(/TYPE ENDPOINT/i);
  });

  it('shipped pipes inventory is larger than the JWT allowlist', () => {
    const shippedPipes = listShippedPipes();
    const allowlistedPipes = [...ALLOWED_TINYBIRD_PIPE_RESOURCES].sort();

    expect(shippedPipes.length).toBeGreaterThan(allowlistedPipes.length);
    for (const pipe of allowlistedPipes) {
      expect(shippedPipes).toContain(pipe);
    }
  });

  it('rejects minting JWT for helper pipe agent_priced_usage', () => {
    expect(() =>
      assertMintableTinybirdScopes([
        { type: TINYBIRD_PIPES_READ_SCOPE, resource: 'agent_priced_usage' },
      ]),
    ).toThrow(/pipe not allowed/i);
  });
});
