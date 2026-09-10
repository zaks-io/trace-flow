import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import archiveConfig from '../wrangler.jsonc';

const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const agentIngestConfigPath = fileURLToPath(
  new URL('../../agent-ingest/wrangler.jsonc', import.meta.url),
);
const environments = ['development', 'preview', 'production'] as const;
type Environment = (typeof environments)[number];
type WranglerConfig = ReturnType<typeof unstable_readConfig>;

const expected = {
  development: {
    name: 'trace-flow-archive-api-dev',
    sentryEnvironment: 'development',
    credentialNamespace: 'f945ee3d71954ffabd364e3db385d3ab',
    bucket: 'trace-flow-agent-archive-dev',
  },
  preview: {
    name: 'trace-flow-archive-api-preview',
    sentryEnvironment: 'preview',
    credentialNamespace: '422b54e456c7446ea5ba4f9ef9a8c84e',
    bucket: 'trace-flow-agent-archive-preview',
  },
  production: {
    name: 'trace-flow-archive-api',
    sentryEnvironment: 'production',
    credentialNamespace: '67241ef9190a4f9d9ac520a347bd44b9',
    bucket: 'trace-flow-agent-archive-prod',
  },
} as const;

const requiredSecrets = ['ARCHIVE_API_SHARED_SECRET', 'ARCHIVE_KEY_WRAPPING_SECRET'];
const expectedObservability = {
  logs: { enabled: true, destinations: ['axiom-logs'], head_sampling_rate: 1 },
  traces: { enabled: true, destinations: ['axiom-traces'], head_sampling_rate: 1 },
};
const durableObjectBindings = [
  ['ARCHIVE_SESSION_LEDGER', 'ArchiveSessionLedger'],
  ['STORAGE_BUDGET', 'StorageBudget'],
];
const forbiddenBindings = [
  'BODY_STORE',
  'BODY_ENCRYPTION_ROOT_KEY',
  'TINYBIRD_ADMIN_TOKEN',
  'TINYBIRD_APPEND_TOKEN',
  'AGENT_INGEST_QUEUE',
];

function readEnvironment(environment: Environment): WranglerConfig {
  return unstable_readConfig(
    { config: configPath, env: environment === 'development' ? '' : environment },
    { hideWarnings: true },
  );
}

function oneBinding<T extends { binding: string }>(
  bindings: T[] | undefined,
  name: string,
  environment: Environment,
): T {
  const matches = bindings?.filter((binding) => binding.binding === name) ?? [];
  assert.equal(matches.length, 1, `${environment} must bind ${name} exactly once`);
  return matches[0]!;
}

function assertArchiveEnvironment(actual: WranglerConfig, environment: Environment): void {
  const contract = expected[environment];
  assert.equal(actual.name, contract.name);
  assert.deepEqual(actual.version_metadata, { binding: 'CF_VERSION_METADATA' });
  assert.deepEqual(actual.vars, {
    SENTRY_ENVIRONMENT: contract.sentryEnvironment,
    ARCHIVE_KEY_VERSION: '1',
  });
  assert.deepEqual(actual.secrets?.required, requiredSecrets);
  assert.deepEqual(actual.observability, expectedObservability);

  const credentials = oneBinding(actual.kv_namespaces, 'COLLECTOR_CREDS', environment);
  assert.equal(credentials.id, contract.credentialNamespace);

  const archiveStorage = oneBinding(actual.r2_buckets, 'ARCHIVE_STORAGE', environment);
  assert.equal(archiveStorage.bucket_name, contract.bucket);
  assert.equal(archiveStorage.jurisdiction, 'us');

  assert.deepEqual(
    actual.durable_objects.bindings.map(({ name, class_name }) => [name, class_name]),
    durableObjectBindings,
  );

  const serialized = JSON.stringify(actual);
  for (const forbidden of forbiddenBindings) assert.ok(!serialized.includes(forbidden));

  if (environment === 'production') {
    assert.equal(actual.workers_dev, false);
    assert.deepEqual(actual.routes, [{ pattern: 'archive.trace-flow.dev', custom_domain: true }]);
  }
}

function assertMigrations(config: WranglerConfig): void {
  assert.deepEqual(config.migrations, [
    { tag: 'v1', new_sqlite_classes: ['ArchiveSessionLedger'] },
    { tag: 'v2', new_sqlite_classes: ['StorageBudget'] },
  ]);
}

describe('Archive API Wrangler resources', () => {
  test('declares observability on each named Worker environment', () => {
    assert.deepEqual(archiveConfig.env.preview.observability, expectedObservability);
    assert.deepEqual(archiveConfig.env.production.observability, expectedObservability);
  });

  test('declares the exact development, preview, and production contracts', () => {
    for (const environment of environments) {
      const config = readEnvironment(environment);
      assertArchiveEnvironment(config, environment);
      assertMigrations(config);
    }
  });

  test('keeps preview credentials and archive objects out of development and production', () => {
    const preview = readEnvironment('preview');
    const development = readEnvironment('development');
    const production = readEnvironment('production');
    const previewCredentials = oneBinding(preview.kv_namespaces, 'COLLECTOR_CREDS', 'preview').id;
    const previewBucket = oneBinding(preview.r2_buckets, 'ARCHIVE_STORAGE', 'preview').bucket_name;

    assert.notEqual(
      previewCredentials,
      oneBinding(development.kv_namespaces, 'COLLECTOR_CREDS', 'development').id,
    );
    assert.notEqual(
      previewCredentials,
      oneBinding(production.kv_namespaces, 'COLLECTOR_CREDS', 'production').id,
    );
    assert.notEqual(
      previewBucket,
      oneBinding(development.r2_buckets, 'ARCHIVE_STORAGE', 'development').bucket_name,
    );
    assert.notEqual(
      previewBucket,
      oneBinding(production.r2_buckets, 'ARCHIVE_STORAGE', 'production').bucket_name,
    );

    const agentIngestPreview = unstable_readConfig(
      { config: agentIngestConfigPath, env: 'preview' },
      { hideWarnings: true },
    );
    assert.equal(
      oneBinding(agentIngestPreview.kv_namespaces, 'COLLECTOR_CREDS', 'preview').id,
      previewCredentials,
    );
  });

  const missingProductionResources: [string, (config: WranglerConfig) => void][] = [
    ['R2 binding', (config) => void config.r2_buckets?.pop()],
    ['US jurisdiction', (config) => void delete config.r2_buckets?.[0]?.jurisdiction],
    [
      'production KV namespace',
      (config) => {
        oneBinding(config.kv_namespaces, 'COLLECTOR_CREDS', 'production').id =
          expected.development.credentialNamespace;
      },
    ],
    ['Durable Object binding', (config) => void config.durable_objects.bindings.pop()],
    ['Durable Object migration', (config) => void config.migrations?.pop()],
    ['required secret', (config) => void config.secrets?.required.pop()],
    ['production custom domain', (config) => void config.routes.pop()],
  ];

  for (const [name, mutate] of missingProductionResources) {
    test(`fails when production loses its ${name}`, () => {
      const config = structuredClone(readEnvironment('production'));
      mutate(config);
      assert.throws(() => {
        assertArchiveEnvironment(config, 'production');
        assertMigrations(config);
      });
    });
  }
});
