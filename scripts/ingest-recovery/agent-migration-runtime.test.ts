import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  migrationBridgeFailure,
  migrationWranglerCommand,
  sanitizeMigrationBridgeLog,
} from './agent-migration-process';

test('migration bridge uses the Agent Consumer locked Wrangler executable and absolute config', () => {
  const command = migrationWranglerCommand(12345);
  const agentConsumerRequire = createRequire(
    new URL('../../apps/agent-consumer/package.json', import.meta.url),
  );
  const packagePath = agentConsumerRequire.resolve('wrangler/package.json');
  const packageDefinition = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    version: string;
  };

  expect(packageDefinition.version).toBe('4.127.1');
  expect(realpathSync(command.command)).toContain(
    realpathSync(packagePath).replace(/package\.json$/, ''),
  );
  expect(command.args[0]).toBe('dev');
  const configIndex = command.args.indexOf('--config');
  expect(configIndex).toBeGreaterThan(0);
  expect(isAbsolute(command.args[configIndex + 1]!)).toBe(true);
  expect(command.args[configIndex + 1]).toEndWith('scripts/ingest-recovery/wrangler.jsonc');
  expect(command.args).toContain('12345');
});

test('migration bridge diagnostics preserve errors and redact credentials', () => {
  const diagnostic = sanitizeMigrationBridgeLog(
    [
      'Wrangler could not establish remote bindings',
      'opaque-secret-value',
      'Authorization: Bearer bearer-secret',
      'token="json-secret"',
      'CLOUDFLARE_API_TOKEN=environment-secret',
    ].join('\n'),
    ['opaque-secret-value'],
  );

  expect(diagnostic).toContain('Wrangler could not establish remote bindings');
  expect(diagnostic).not.toContain('opaque-secret-value');
  expect(diagnostic).not.toContain('bearer-secret');
  expect(diagnostic).not.toContain('json-secret');
  expect(diagnostic).not.toContain('environment-secret');
  expect(diagnostic.match(/\[REDACTED\]/g)).toHaveLength(4);
});

test('migration bridge failures report the sanitized Wrangler diagnostic', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-migration-runtime-test-'));
  const logPath = join(directory, 'bridge.log');
  writeFileSync(logPath, 'Authentication failed for runtime-secret');
  try {
    const failure = migrationBridgeFailure('Migration bridge failed with exit code 1', logPath, [
      'runtime-secret',
    ]);
    expect(failure.message).toContain('Migration bridge failed with exit code 1');
    expect(failure.message).toContain('Authentication failed for [REDACTED]');
    expect(failure.message).not.toContain('runtime-secret');
  } finally {
    rmSync(directory, { recursive: true });
  }
});
