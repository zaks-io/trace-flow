import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentsE2eBaseUrl, agentsStorageStatePath } from '../e2e/agents-e2e-config';

mkdirSync(dirname(agentsStorageStatePath), { recursive: true });

const targetUrl = new URL('/app/agents', agentsE2eBaseUrl);

console.log(`Opening ${targetUrl.toString()}`);
console.log(`Saving auth state to ${agentsStorageStatePath}`);

const result = spawnSync(
  'bunx',
  ['playwright', 'codegen', `--save-storage=${agentsStorageStatePath}`, targetUrl.toString()],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
