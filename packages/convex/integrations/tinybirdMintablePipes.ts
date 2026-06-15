import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Validates a shipped pipe file is a row-secured TYPE ENDPOINT suitable for JWT minting. */
export function assertRowSecuredEndpointPipe(pipeName: string, pipesDir: string): void {
  const pipePath = join(pipesDir, `${pipeName}.pipe`);
  const content = readFileSync(pipePath, 'utf8');

  if (!content.includes('TYPE ENDPOINT')) {
    throw new Error(`${pipeName} must be TYPE ENDPOINT to be JWT-mintable`);
  }

  const hasRowSecurity = content.includes('String(api_keys') || content.includes('String(org_id');
  if (!hasRowSecurity) {
    throw new Error(`${pipeName} must filter on api_keys or org_id fixed_params`);
  }
}
