import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureCommand, formatProcessFailure } from './archive-api-process-diagnostics';

export const cloudDev = {
  deployment: 'hardy-iguana-812',
  convexSiteUrl: 'https://hardy-iguana-812.convex.site',
  workerName: 'trace-flow-archive-api-dev',
  workerUrl: 'https://trace-flow-archive-api-dev.isaac-a46.workers.dev',
  bucket: 'trace-flow-agent-archive-dev',
  credentialNamespace: 'f945ee3d71954ffabd364e3db385d3ab',
} as const;

const repoRoot = resolve(import.meta.dirname, '../..');
const archiveApiRoot = resolve(repoRoot, 'apps/archive-api');
const keychainService = 'com.trace-flow.archive-api.cloud-dev';
const requiredSecretNames = ['ARCHIVE_API_SHARED_SECRET', 'ARCHIVE_KEY_WRAPPING_SECRET'] as const;

interface VersionBinding {
  name?: string;
  type?: string;
  text?: string;
  bucket_name?: string;
  jurisdiction?: string;
  namespace_id?: string;
}

interface VersionView {
  id?: string;
  resources?: { bindings?: VersionBinding[] };
}

interface Deployment {
  created_on?: string;
  versions?: { version_id?: string; percentage?: number }[];
}

function cli(): string {
  return process.platform === 'win32' ? 'bunx.cmd' : 'bunx';
}

async function runJson<T>(label: string, cwd: string, args: string[]): Promise<T> {
  const result = await captureCommand(cli(), args, { cwd });
  if (result.exitCode !== 0) throw new Error(formatProcessFailure(label, result));
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON\n${formatProcessFailure(label, result)}`);
  }
}

function oneBinding(bindings: VersionBinding[], name: string): VersionBinding {
  const matches = bindings.filter((binding) => binding.name === name);
  assert.equal(matches.length, 1, `Cloud-Dev Worker must bind ${name} exactly once`);
  return matches[0]!;
}

export function assertCloudDevVersion(version: VersionView): void {
  const bindings = version.resources?.bindings ?? [];
  assert.equal(oneBinding(bindings, 'CONVEX_SITE_URL').text, cloudDev.convexSiteUrl);
  assert.equal(oneBinding(bindings, 'ARCHIVE_STORAGE').bucket_name, cloudDev.bucket);
  assert.equal(oneBinding(bindings, 'ARCHIVE_STORAGE').jurisdiction, 'us');
  assert.equal(oneBinding(bindings, 'COLLECTOR_CREDS').namespace_id, cloudDev.credentialNamespace);
  for (const name of requiredSecretNames)
    assert.equal(oneBinding(bindings, name).type, 'secret_text');
}

export function assertMatchingSharedSecret(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error('Cloud-Dev Convex and Archive API shared secrets differ');
  }
}

async function currentVersion(): Promise<VersionView> {
  const deployments = await runJson<Deployment[]>('Cloud-Dev deployment lookup', archiveApiRoot, [
    'wrangler',
    'deployments',
    'list',
    '--name',
    cloudDev.workerName,
    '--json',
  ]);
  const ordered = [...deployments].sort((left, right) =>
    (left.created_on ?? '').localeCompare(right.created_on ?? ''),
  );
  const latest = ordered[ordered.length - 1];
  const versionId = latest?.versions?.find((version) => version.percentage === 100)?.version_id;
  assert.ok(versionId, `No active version found for ${cloudDev.workerName}`);
  return runJson<VersionView>('Cloud-Dev version lookup', archiveApiRoot, [
    'wrangler',
    'versions',
    'view',
    versionId,
    '--name',
    cloudDev.workerName,
    '--json',
  ]);
}

async function assertHealth(): Promise<void> {
  const response = await fetch(`${cloudDev.workerUrl}/healthz`);
  assert.equal(response.status, 200, 'Cloud-Dev Archive API health check failed');
  assert.deepEqual(await response.json(), { status: 'ok' });
}

async function keychainSecret(account: (typeof requiredSecretNames)[number]): Promise<string> {
  assert.equal(process.platform, 'darwin', `${account} is required outside macOS`);
  const result = await captureCommand(
    'security',
    ['find-generic-password', '-s', keychainService, '-a', account, '-w'],
    { cwd: repoRoot },
  );
  if (result.exitCode !== 0)
    throw new Error(formatProcessFailure(`${account} Keychain lookup`, result));
  const value = result.stdout.replace(/[\r\n]+$/u, '');
  assert.ok(value, `${account} Keychain value is empty`);
  return value;
}

async function loadSecrets(): Promise<Record<(typeof requiredSecretNames)[number], string>> {
  const entries = await Promise.all(
    requiredSecretNames.map(async (name) => {
      const configured = process.env[name];
      if (configured !== undefined) {
        assert.ok(configured, `${name} is empty`);
        return [name, configured] as const;
      }
      return [name, await keychainSecret(name)] as const;
    }),
  );
  const secrets = Object.fromEntries(entries) as Record<
    (typeof requiredSecretNames)[number],
    string
  >;
  assert.ok(!/[\r\n]/u.test(secrets.ARCHIVE_API_SHARED_SECRET), 'Shared secret contains a newline');
  assert.ok(
    !/[\r\n]/u.test(secrets.ARCHIVE_KEY_WRAPPING_SECRET),
    'Wrapping secret contains a newline',
  );
  assert.equal(
    atob(secrets.ARCHIVE_KEY_WRAPPING_SECRET).length,
    32,
    'Wrapping secret must decode to 32 bytes',
  );
  return secrets;
}

async function assertConvexSecret(sharedSecret: string): Promise<void> {
  const result = await captureCommand(
    cli(),
    ['convex', 'env', 'get', '--deployment', cloudDev.deployment, 'ARCHIVE_API_SHARED_SECRET'],
    { cwd: repoRoot },
  );
  if (result.exitCode !== 0) {
    throw new Error(formatProcessFailure('Cloud-Dev Convex secret lookup', result, [sharedSecret]));
  }
  assertMatchingSharedSecret(result.stdout.replace(/[\r\n]+$/u, ''), sharedSecret);
}

async function deploy(): Promise<void> {
  const secrets = await loadSecrets();
  await assertConvexSecret(secrets.ARCHIVE_API_SHARED_SECRET);
  const before = await currentVersion();
  assertCloudDevVersion(before);
  await assertHealth();

  const secretsDirectory = await mkdtemp(join(tmpdir(), 'trace-flow-archive-dev-'));
  const secretsFile = join(secretsDirectory, 'archive-api.env');
  try {
    await chmod(secretsDirectory, 0o700);
    await writeFile(
      secretsFile,
      requiredSecretNames.map((name) => `${name}=${secrets[name]}\n`).join(''),
      { mode: 0o600 },
    );
    const result = await captureCommand(
      cli(),
      [
        'wrangler',
        'deploy',
        '--env=',
        '--name',
        cloudDev.workerName,
        '--secrets-file',
        secretsFile,
        '--var',
        `CONVEX_SITE_URL:${cloudDev.convexSiteUrl}`,
      ],
      { cwd: archiveApiRoot },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        formatProcessFailure('Cloud-Dev Archive API deployment', result, Object.values(secrets)),
      );
    }
  } finally {
    await rm(secretsDirectory, { recursive: true, force: true });
  }

  const after = await currentVersion();
  assertCloudDevVersion(after);
  await assertHealth();
  console.log(
    JSON.stringify({
      status: 'ok',
      deployment: cloudDev.deployment,
      worker: cloudDev.workerName,
      version: after.id,
      convexSiteUrl: cloudDev.convexSiteUrl,
    }),
  );
}

if (import.meta.main) await deploy();
