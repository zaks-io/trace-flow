import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  assertCloudDevVersion,
  assertMatchingSharedSecret,
  cloudDev,
  cloudDevConvexErasureConfig,
} from './archive-api-deploy';

const archivePackagePath = resolve(import.meta.dirname, '../../apps/archive-api/package.json');

function expectedVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'version-id',
    resources: {
      bindings: [
        { name: 'ARCHIVE_API_SHARED_SECRET', type: 'secret_text' },
        { name: 'ARCHIVE_KEY_WRAPPING_SECRET', type: 'secret_text' },
        { name: 'CONVEX_SITE_URL', type: 'plain_text', text: cloudDev.convexSiteUrl },
        {
          name: 'ARCHIVE_STORAGE',
          type: 'r2_bucket',
          bucket_name: cloudDev.bucket,
          jurisdiction: 'us',
        },
        {
          name: 'COLLECTOR_CREDS',
          type: 'kv_namespace',
          namespace_id: cloudDev.credentialNamespace,
        },
      ],
    },
    ...overrides,
  };
}

describe('normal Cloud-Dev archive deployment', () => {
  test('routes the existing package command through the guarded deployment', async () => {
    const packageJson = await Bun.file(archivePackagePath).json();
    assert.equal(packageJson.scripts['deploy:dev'], 'bun ../../scripts/dev/archive-api-deploy.ts');
    assert.equal(cloudDev.workerName, 'trace-flow-archive-api-dev');
    assert.equal(cloudDev.workerUrl, 'https://trace-flow-archive-api-dev.isaac-a46.workers.dev');
    assert.deepEqual(cloudDevConvexErasureConfig, {
      ARCHIVE_API_WORKER_NAME: cloudDev.workerName,
      ARCHIVE_API_URL: cloudDev.workerUrl,
    });
  });

  test('configures preview and production Convex with their exact Archive API Workers', async () => {
    const preview = await Bun.file(
      resolve(import.meta.dirname, '../../.github/workflows/preview.yml'),
    ).text();
    const production = await Bun.file(
      resolve(import.meta.dirname, '../../.github/workflows/deploy.yml'),
    ).text();

    assert.match(preview, /ARCHIVE_API_WORKER_NAME trace-flow-archive-api-preview/u);
    assert.match(
      preview,
      /ARCHIVE_API_URL https:\/\/trace-flow-archive-api-preview\.isaac-a46\.workers\.dev/u,
    );
    assert.match(production, /ARCHIVE_API_WORKER_NAME trace-flow-archive-api\n/u);
    assert.match(production, /ARCHIVE_API_URL https:\/\/archive\.trace-flow\.dev/u);
    for (const workflow of [preview, production]) {
      assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/u);
      assert.match(workflow, /CLOUDFLARE_API_TOKEN/u);
    }
  });

  test('accepts the exact hardy-iguana-812 Worker resources', () => {
    assertCloudDevVersion(expectedVersion());
  });

  test('rejects a production or missing Convex origin', () => {
    const production = expectedVersion();
    const origin = production.resources.bindings.find(
      (binding) => binding.name === 'CONVEX_SITE_URL',
    );
    assert.ok(origin);
    origin.text = 'https://laudable-bison-427.convex.site';
    assert.throws(() => assertCloudDevVersion(production));

    const missing = expectedVersion();
    missing.resources.bindings = missing.resources.bindings.filter(
      (binding) => binding.name !== 'CONVEX_SITE_URL',
    );
    assert.throws(() => assertCloudDevVersion(missing));
  });

  test('reports a shared-secret mismatch without exposing either value', () => {
    const convexSecret = 'convex-secret-value';
    const workerSecret = 'worker-secret-value';
    assert.throws(
      () => assertMatchingSharedSecret(convexSecret, workerSecret),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(convexSecret));
        assert.ok(!error.message.includes(workerSecret));
        return true;
      },
    );
  });
});
