export {};

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const namespaceId = process.env.TRACE_FLOW_ARCHIVE_LEDGER_NAMESPACE_ID;
const archiveUrl = process.env.ARCHIVE_API_URL?.replace(/\/$/u, '');
const archiveSecret = process.env.ARCHIVE_API_SHARED_SECRET;

if (!accountId || !apiToken || !namespaceId || !archiveUrl || !archiveSecret) {
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, TRACE_FLOW_ARCHIVE_LEDGER_NAMESPACE_ID, ARCHIVE_API_URL, and ARCHIVE_API_SHARED_SECRET are required',
  );
}

interface CloudflareObjectPage {
  success: boolean;
  result: { id?: string; hasStoredData?: boolean }[];
  result_info?: { cursor?: string };
  errors?: { message?: string }[];
}

async function listNamespacePage(cursor?: string): Promise<CloudflareObjectPage> {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/durable_objects/namespaces/${namespaceId}/objects`,
  );
  url.searchParams.set('limit', '100');
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const page = (await response.json()) as CloudflareObjectPage;
  if (!response.ok || !page.success || !Array.isArray(page.result)) {
    throw new Error(
      `Cloudflare Durable Objects listing failed with HTTP ${response.status}: ${page.errors?.[0]?.message ?? 'unknown error'}`,
    );
  }
  return page;
}

async function register(ledgerIds: string[]): Promise<{
  inspected: number;
  committed: number;
  registered: number;
}> {
  const response = await fetch(`${archiveUrl}/internal/archive-registry/backfill`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${archiveSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ledgerIds }),
  });
  if (!response.ok) {
    throw new Error(`Archive registry backfill failed with HTTP ${response.status}`);
  }
  return (await response.json()) as {
    inspected: number;
    committed: number;
    registered: number;
  };
}

let cursor: string | undefined;
let inspected = 0;
let committed = 0;
let registered = 0;
do {
  const page = await listNamespacePage(cursor);
  const ledgerIds = page.result.flatMap((object) =>
    object.hasStoredData && typeof object.id === 'string' ? [object.id] : [],
  );
  if (ledgerIds.length > 0) {
    const result = await register(ledgerIds);
    inspected += result.inspected;
    committed += result.committed;
    registered += result.registered;
  }
  cursor = page.result_info?.cursor || undefined;
} while (cursor);

process.stdout.write(`${JSON.stringify({ inspected, committed, registered })}\n`);
