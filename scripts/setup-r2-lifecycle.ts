import { isDeepStrictEqual } from 'node:util';
import { bodyRetentionRules } from './ci/body-retention.mjs';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const buckets = process.argv.slice(2);

if (!accountId || !apiToken) throw new Error('Cloudflare account ID and API token are required');
if (buckets.length === 0) throw new Error('Pass the exact storage bucket names to configure');
if (buckets.some((name) => !/^trace-flow-storage-[a-z0-9-]+$/.test(name))) {
  throw new Error('Expected explicit trace-flow-storage-* bucket names');
}

async function lifecycle(bucket: string, body?: string) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/lifecycle`,
    {
      method: body ? 'PUT' : 'GET',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body,
    },
  );
  const result = (await response.json()) as { success: boolean; result?: { rules?: unknown[] } };
  if (!response.ok || !result.success) {
    throw new Error(
      `R2 lifecycle ${body ? 'write' : 'read'} failed for ${bucket}: HTTP ${response.status}`,
    );
  }
  return result.result;
}

for (const bucket of buckets) {
  const current = await lifecycle(bucket);
  const rules = bodyRetentionRules(current?.rules);
  if (!isDeepStrictEqual(current?.rules, rules)) {
    await lifecycle(bucket, JSON.stringify({ rules }));
  }
  const verified = await lifecycle(bucket);
  if (!isDeepStrictEqual(verified?.rules, rules)) {
    throw new Error(`R2 lifecycle verification failed for ${bucket}`);
  }
  console.log(`Verified pending trace deliveries are excluded from expiration in ${bucket}`);
}
