/**
 * Sets a 30-day object expiration lifecycle rule on trace-flow R2 storage buckets.
 * Run once per environment: `bun scripts/setup-r2-lifecycle.ts`
 *
 * Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars.
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !apiToken) {
  console.error('Required env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

const BUCKET_PREFIXES = ['trace-flow-storage-dev', 'trace-flow-storage-prod'];
const EXPIRATION_DAYS = 30;

async function cfFetch(path: string, options?: RequestInit) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    },
  );
  return response.json() as Promise<{ success: boolean; errors?: { message: string }[] }>;
}

async function listBuckets(): Promise<{ name: string }[]> {
  const result = (await cfFetch('/r2/buckets')) as { result: { buckets: { name: string }[] } };
  return result.result?.buckets ?? [];
}

async function setLifecycleRule(bucketName: string) {
  const rule = {
    rules: [
      {
        id: 'auto-expire-30d',
        enabled: true,
        conditions: { prefix: '' },
        actions: {
          deleteObject: { daysAfterLastModificationDate: EXPIRATION_DAYS },
        },
      },
    ],
  };

  const result = await cfFetch(`/r2/buckets/${bucketName}/lifecycle`, {
    method: 'PUT',
    body: JSON.stringify(rule),
  });

  if (result.success) {
    console.log(`Set ${EXPIRATION_DAYS}-day expiration on ${bucketName}`);
  } else {
    console.error(`Failed for ${bucketName}:`, result.errors);
  }
}

async function main() {
  const buckets = await listBuckets();
  const targetBuckets = buckets.filter((b) =>
    BUCKET_PREFIXES.some((prefix) => b.name.startsWith(prefix)),
  );

  if (targetBuckets.length === 0) {
    console.log('No matching trace-flow-storage-* buckets found');
    return;
  }

  console.log(
    `Found ${targetBuckets.length} bucket(s):`,
    targetBuckets.map((b) => b.name),
  );

  for (const bucket of targetBuckets) {
    await setLifecycleRule(bucket.name);
  }
}

main().catch(console.error);
