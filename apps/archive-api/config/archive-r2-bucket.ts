import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  captureCommand,
  formatProcessFailure,
  sanitizeProcessOutput,
} from '../../../scripts/dev/archive-api-process-diagnostics';

const archiveApiRoot = resolve(import.meta.dirname, '..');
export const productionArchiveBucket = {
  name: 'trace-flow-agent-archive-prod',
  jurisdiction: 'us',
} as const;

interface CloudflareEnvelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: { name?: string };
}

export type BucketInspection = { state: 'exists' } | { state: 'missing' };

export function classifyBucketResponse(
  responseStatus: number,
  envelope: CloudflareEnvelope,
): BucketInspection {
  if (responseStatus === 404 && envelope.errors?.some((error) => error.code === 10006)) {
    return { state: 'missing' };
  }
  if (responseStatus >= 200 && responseStatus < 300 && envelope.success) {
    assert.equal(envelope.result?.name, productionArchiveBucket.name);
    return { state: 'exists' };
  }
  throw new Error(
    `Production archive bucket lookup failed with HTTP ${responseStatus}\nresponse:\n${sanitizeProcessOutput(JSON.stringify(envelope))}`,
  );
}

function requiredEnvironment(name: 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_API_TOKEN'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function inspectProductionArchiveBucket(): Promise<BucketInspection> {
  const accountId = requiredEnvironment('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = requiredEnvironment('CLOUDFLARE_API_TOKEN');
  const endpoint = new URL(
    `/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${productionArchiveBucket.name}`,
    'https://api.cloudflare.com',
  );
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'cf-r2-jurisdiction': productionArchiveBucket.jurisdiction,
      },
    });
  } catch (error) {
    throw new Error('Production archive bucket lookup failed before an HTTP response', {
      cause: error,
    });
  }

  const body = await response.text();
  let envelope: CloudflareEnvelope;
  try {
    envelope = JSON.parse(body) as CloudflareEnvelope;
  } catch {
    throw new Error(
      `Production archive bucket lookup returned invalid JSON with HTTP ${response.status}\nresponse:\n${sanitizeProcessOutput(body, [apiToken])}`,
    );
  }
  return classifyBucketResponse(response.status, envelope);
}

async function ensureProductionArchiveBucket(): Promise<void> {
  const inspection = await inspectProductionArchiveBucket();
  if (inspection.state === 'missing') {
    const cli = process.platform === 'win32' ? 'bunx.cmd' : 'bunx';
    const result = await captureCommand(
      cli,
      [
        'wrangler',
        'r2',
        'bucket',
        'create',
        productionArchiveBucket.name,
        '--jurisdiction',
        productionArchiveBucket.jurisdiction,
      ],
      { cwd: archiveApiRoot },
    );
    if (result.exitCode !== 0) {
      throw new Error(formatProcessFailure('Production archive bucket creation', result));
    }
  }
  assert.deepEqual(await inspectProductionArchiveBucket(), { state: 'exists' });
  console.log(JSON.stringify({ status: 'ok', bucket: productionArchiveBucket.name }));
}

if (import.meta.main) await ensureProductionArchiveBucket();
