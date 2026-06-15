import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_KEYS_FILTER_PATTERN = /String\(api_keys/;
const ORG_ID_FILTER_PATTERN = /String\(org_id/;

/** Validates a shipped pipe file is a row-secured TYPE ENDPOINT suitable for JWT minting. */
export function assertRowSecuredEndpointPipe(pipeName: string, pipesDir: string): void {
  const pipePath = join(pipesDir, `${pipeName}.pipe`);
  const content = readFileSync(pipePath, 'utf8');

  if (!content.includes('TYPE ENDPOINT')) {
    throw new Error(`${pipeName} must be TYPE ENDPOINT to be JWT-mintable`);
  }

  const hasRowSecurity =
    API_KEYS_FILTER_PATTERN.test(content) || ORG_ID_FILTER_PATTERN.test(content);
  if (!hasRowSecurity) {
    throw new Error(`${pipeName} must filter on api_keys or org_id fixed_params`);
  }
}
