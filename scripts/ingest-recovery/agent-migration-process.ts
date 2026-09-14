import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const agentConsumerRequire = createRequire(
  new URL('../../apps/agent-consumer/package.json', import.meta.url),
);
export function migrationWranglerCommand(port = 8798): { command: string; args: string[] } {
  const packagePath = agentConsumerRequire.resolve('wrangler/package.json');
  const packageDefinition = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    bin?: { wrangler?: unknown };
  };
  if (typeof packageDefinition.bin?.wrangler !== 'string') {
    throw new Error('Installed Agent Consumer Wrangler package has no CLI executable');
  }
  return {
    command: resolve(dirname(packagePath), packageDefinition.bin.wrangler),
    args: [
      'dev',
      '--config',
      join(repositoryRoot, 'scripts/ingest-recovery/wrangler.jsonc'),
      '--env',
      'production',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--show-interactive-dev-session',
      'false',
    ],
  };
}

export function sanitizeMigrationBridgeLog(output: string, sensitiveValues: string[] = []): string {
  let sanitized = output;
  const values = sensitiveValues
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const value of new Set(values)) sanitized = sanitized.replaceAll(value, '[REDACTED]');
  return sanitized
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(
      /((?:secret|token|credential|authorization)["']?\s*[:=]\s*["'])[^"'\r\n]+/giu,
      '$1[REDACTED]',
    )
    .replace(/((?:CLOUDFLARE_API_TOKEN|CONVEX_DEPLOY_KEY|TB_TOKEN)=)[^\r\n]*/gu, '$1[REDACTED]');
}

function migrationSecretValues(): string[] {
  return Object.entries(process.env).flatMap(([name, value]) =>
    value && /credential|key|password|secret|token/iu.test(name) ? [value] : [],
  );
}

export function migrationBridgeFailure(
  message: string,
  logPath: string,
  sensitiveValues = migrationSecretValues(),
): Error {
  let diagnostic: string;
  try {
    diagnostic = sanitizeMigrationBridgeLog(readFileSync(logPath, 'utf8'), sensitiveValues);
  } catch (error) {
    diagnostic = `Unable to read Wrangler diagnostic: ${error instanceof Error ? error.message : String(error)}`;
  }
  return new Error(`${message}\nWrangler diagnostic:\n${diagnostic || '<empty>'}`);
}
