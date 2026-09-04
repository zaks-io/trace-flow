import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const integrationEnabled = process.env.TRACE_FLOW_CONVEX_INTEGRATION === '1';
const deployment = process.env.TRACE_FLOW_CONVEX_TEST_DEPLOYMENT ?? 'dev';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface SeedResult {
  orgId: string;
  tokenIdentifier: string;
  collectorCredentialId: string;
  idempotencyKey: string;
}

interface EnrollmentResult {
  enrollmentId: string;
  contributionId: string;
  created: boolean;
}

function assertCloudDevDeployment() {
  if (deployment !== 'dev') {
    throw new Error('Archive concurrency integration tests require the Cloud-Dev deployment');
  }
}

function runConvex<T>(
  functionName: string,
  args: Record<string, unknown>,
  tokenIdentifier?: string,
  allowEmptyOutput = false,
): Promise<T> {
  assertCloudDevDeployment();
  const cli = process.platform === 'win32' ? 'bunx.cmd' : 'bunx';
  const cliArgs = [
    'convex',
    'run',
    '--deployment',
    deployment,
    '--typecheck',
    'disable',
    '--codegen',
    'disable',
  ];
  if (tokenIdentifier) {
    cliArgs.push('--identity', JSON.stringify({ tokenIdentifier }));
  }
  cliArgs.push(functionName, JSON.stringify(args));

  return new Promise((resolveResult, reject) => {
    const child = spawn(cli, cliArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => {
      reject(new Error(`Unable to start Convex command for ${functionName}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Convex command ${functionName} failed with exit code ${code}`));
        return;
      }
      if (stdout.trim().length === 0) {
        if (allowEmptyOutput) {
          resolveResult(null as T);
        } else {
          reject(new Error(`Convex command ${functionName} returned no output`));
        }
        return;
      }
      try {
        resolveResult(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`Convex command ${functionName} returned invalid JSON`));
      }
    });
  });
}

describe.skipIf(!integrationEnabled)('archive control-plane Convex integration', () => {
  it('creates exactly one enrollment for simultaneous first-use requests', async () => {
    const seed = await runConvex<SeedResult>('archiveIntegrationSeed:seedConcurrentEnrollment', {});
    const enrollmentArgs = {
      collectorCredentialId: seed.collectorCredentialId,
      authorizedSources: [{ source: 'claude', historyChoice: 'new_only' }],
      idempotencyKey: seed.idempotencyKey,
    };

    try {
      await runConvex('api.archive.activate', {}, seed.tokenIdentifier);
      const results = await Promise.all([
        runConvex<EnrollmentResult>('api.archive.enroll', enrollmentArgs, seed.tokenIdentifier),
        runConvex<EnrollmentResult>('api.archive.enroll', enrollmentArgs, seed.tokenIdentifier),
      ]);

      expect(new Set(results.map((result) => result.enrollmentId)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);

      const status = await runConvex<{
        contributions: { collectors: unknown[] }[];
        enrolledCollectorCount: number;
      }>('api.archive.getStatus', {}, seed.tokenIdentifier);
      expect(status.enrolledCollectorCount).toBe(1);
      expect(status.contributions).toHaveLength(1);
      expect(status.contributions[0]?.collectors).toHaveLength(1);
    } finally {
      await runConvex(
        'archiveIntegrationSeed:cleanupConcurrentEnrollment',
        {
          orgId: seed.orgId,
        },
        undefined,
        true,
      );
    }
  }, 30_000);
});
