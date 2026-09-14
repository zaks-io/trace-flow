import { expect, mock, spyOn, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const childMode = process.env.TRACE_FLOW_TARGETED_RECOVERY_GUARD_TEST === '1';

if (childMode) {
  const tinybirdHost = 'https://api.us-west-2.aws.tinybird.co';
  const appendTokenSha256 = 'a'.repeat(64);
  const calls: string[] = [];
  const diagnostics: string[] = [];
  let runtimeClosed = false;

  mock.module('./agent-migration-runtime', () => ({
    startMigrationRuntime: async () => ({
      tb: {
        host: tinybirdHost,
        tokenFingerprints: async () => [appendTokenSha256],
      },
      url: 'http://127.0.0.1:8798',
      close: () => {
        runtimeClosed = true;
      },
    }),
    requireAgentProducerMaintenance: async () => {},
    requireDrainedAgentQueues: async () => {},
  }));
  spyOn(console, 'error').mockImplementation((...values) => {
    diagnostics.push(values.map(String).join(' '));
  });
  globalThis.fetch = Object.assign(
    mock(async (input: string | URL | Request) => {
      calls.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
      return Response.json({
        migrationTarget: { tinybirdHost, appendTokenSha256 },
        legacy: { migrationId: 'bounded-agent-ingestion-v1' },
        migration: null,
      });
    }),
    { preconnect: mock(() => {}) },
  );
  process.argv.splice(
    0,
    process.argv.length,
    'bun',
    'recover-frozen-agent.ts',
    '--org',
    'org-a',
    '--census',
    'must-not-be-read.sqlite',
    '--journal',
    'must-not-be-created.sqlite',
  );

  await import('./recover-frozen-agent');
  const result = { calls, diagnostics, runtimeClosed, exitCode: process.exitCode };
  process.exitCode = 0;
  console.log(JSON.stringify(result));
} else {
  test('targeted recovery refuses a frozen source before bounded migration completes', async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, TRACE_FLOW_TARGETED_RECOVERY_GUARD_TEST: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      calls: ['/inspectIngestionMigration'],
      diagnostics: ['Frozen recovery requires a completed bounded ingestion migration'],
      runtimeClosed: true,
      exitCode: 1,
    });
  });
}
