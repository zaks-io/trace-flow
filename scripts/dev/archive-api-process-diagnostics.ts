import { spawn } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

const secretEnvironmentNames = [
  'ARCHIVE_API_SHARED_SECRET',
  'ARCHIVE_KEY_WRAPPING_SECRET',
  'CLOUDFLARE_API_TOKEN',
  'CONVEX_DEPLOY_KEY',
];

export function configuredSecretValues(): string[] {
  return secretEnvironmentNames.flatMap((name) => {
    const value = process.env[name];
    return value ? [value] : [];
  });
}

export function sensitiveArgumentValues(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    if (
      typeof nested === 'string' &&
      /credential|secret|token|wrapped|authorization|key/iu.test(key)
    ) {
      return [nested];
    }
    return sensitiveArgumentValues(nested);
  });
}

export function sanitizeProcessOutput(output: string, sensitiveValues: string[] = []): string {
  let sanitized = output;
  const values = [...configuredSecretValues(), ...sensitiveValues]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const value of new Set(values)) sanitized = sanitized.replaceAll(value, '[REDACTED]');

  return sanitized
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(
      /((?:secret|token|credential|wrapped_key|wrappedKey|authorization)["']?\s*[:=]\s*["'])[^"'\r\n]+/giu,
      '$1[REDACTED]',
    )
    .replace(
      /((?:ARCHIVE_API_SHARED_SECRET|ARCHIVE_KEY_WRAPPING_SECRET|CLOUDFLARE_API_TOKEN|CONVEX_DEPLOY_KEY)=)[^\r\n]*/gu,
      '$1[REDACTED]',
    );
}

export function formatProcessFailure(
  label: string,
  result: CommandResult,
  sensitiveValues: string[] = [],
): string {
  const exit = result.spawnError
    ? `spawn error: ${result.spawnError}`
    : `exit code ${result.exitCode}`;
  const stdout = sanitizeProcessOutput(result.stdout, sensitiveValues) || '<empty>';
  const stderr = sanitizeProcessOutput(result.stderr, sensitiveValues) || '<empty>';
  return `${label} failed with ${exit}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
}

export function captureCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolveResult({ exitCode: null, stdout, stderr, spawnError: error.message });
    });
    child.on('close', (exitCode) => {
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}
