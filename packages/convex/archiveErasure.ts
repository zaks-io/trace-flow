import { v } from 'convex/values';
import { internalAction, internalMutation } from './_generated/server';

const ARCHIVE_LEDGER_CLASS = 'ArchiveSessionLedger';
const CLOUDFLARE_NAMESPACE_PAGE_SIZE = 1000;
const CLOUDFLARE_OBJECT_PAGE_SIZE = 100;
const KEY_DELETE_PAGE_SIZE = 500;

interface CloudflareNamespace {
  id?: string;
  class?: string;
  script?: string;
}

interface CloudflareObject {
  id?: string;
  hasStoredData?: boolean;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  result_info?: {
    page?: number;
    total_pages?: number;
    cursor?: string;
  };
}

interface ArchiveErasureConfig {
  accountId: string;
  apiToken: string;
  archiveApiUrl: string;
  archiveApiSharedSecret: string;
  workerName: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is not set`);
  return value;
}

function erasureConfig(): ArchiveErasureConfig {
  return {
    accountId: requiredEnvironment('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: requiredEnvironment('CLOUDFLARE_API_TOKEN'),
    archiveApiUrl: requiredEnvironment('ARCHIVE_API_URL').replace(/\/$/u, ''),
    archiveApiSharedSecret: requiredEnvironment('ARCHIVE_API_SHARED_SECRET'),
    workerName: requiredEnvironment('ARCHIVE_API_WORKER_NAME'),
  };
}

async function cloudflareGet<T>(
  config: ArchiveErasureConfig,
  path: string,
): Promise<CloudflareEnvelope<T>> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null) {
    throw new Error(`Cloudflare Durable Object lookup failed with HTTP ${response.status}`);
  }
  const envelope = body as CloudflareEnvelope<T>;
  if (!response.ok || envelope.success !== true || envelope.result === undefined) {
    throw new Error(`Cloudflare Durable Object lookup failed with HTTP ${response.status}`);
  }
  return envelope;
}

export function selectArchiveLedgerNamespace(
  namespaces: CloudflareNamespace[],
  workerName: string,
): string {
  const matches = namespaces.filter(
    (namespace) => namespace.script === workerName && namespace.class === ARCHIVE_LEDGER_CLASS,
  );
  if (matches.length !== 1 || !matches[0]?.id) {
    throw new Error(
      `Expected one ${ARCHIVE_LEDGER_CLASS} namespace for Archive API Worker ${workerName}`,
    );
  }
  return matches[0].id;
}

async function resolveArchiveLedgerNamespace(config: ArchiveErasureConfig): Promise<string> {
  const namespaces: CloudflareNamespace[] = [];
  let page = 1;
  while (true) {
    const envelope = await cloudflareGet<CloudflareNamespace[]>(
      config,
      `/accounts/${encodeURIComponent(config.accountId)}/workers/durable_objects/namespaces?page=${page}&per_page=${CLOUDFLARE_NAMESPACE_PAGE_SIZE}`,
    );
    namespaces.push(...(envelope.result ?? []));
    const totalPages = envelope.result_info?.total_pages;
    if (totalPages === undefined || page >= totalPages) break;
    page += 1;
  }
  return selectArchiveLedgerNamespace(namespaces, config.workerName);
}

async function callArchiveApi(
  config: ArchiveErasureConfig,
  phase: 'begin' | 'ledgers' | 'finish',
  body: {
    orgId: string;
    ledgerIds?: string[];
    includeRegistered?: boolean;
    registeredCursor?: string;
  },
): Promise<{ erased?: boolean; registeredCursor?: string }> {
  const response = await fetch(`${config.archiveApiUrl}/internal/archive-erasure/${phase}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.archiveApiSharedSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.text();
    throw new Error(`Archive API erasure ${phase} failed with HTTP ${response.status}`);
  }
  const result: unknown = await response.json();
  if (typeof result !== 'object' || result === null) {
    throw new Error('Archive API erasure returned an invalid response');
  }
  const erased = 'erased' in result ? result.erased : undefined;
  const registeredCursor = 'registeredCursor' in result ? result.registeredCursor : undefined;
  if (
    registeredCursor !== undefined &&
    (typeof registeredCursor !== 'string' || !/^[a-f0-9]{64}$/u.test(registeredCursor))
  ) {
    throw new Error('Archive API erasure returned an invalid registry cursor');
  }
  if (erased !== undefined && typeof erased !== 'boolean') {
    throw new Error('Archive API erasure returned an invalid completion state');
  }
  return {
    ...(typeof erased === 'boolean' ? { erased } : {}),
    ...(typeof registeredCursor === 'string' ? { registeredCursor } : {}),
  };
}

export const stageArchiveErasure = internalAction({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const config = erasureConfig();
    await callArchiveApi(config, 'begin', { orgId: args.orgId });
    return null;
  },
});

export const destroyArchiveKeys = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.object({
    keyVersionsDeleted: v.number(),
    custodyDeleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    let remaining = KEY_DELETE_PAGE_SIZE;
    let keyVersionsDeleted = 0;
    let custodyDeleted = 0;
    const versions = await ctx.db
      .query('archiveEncryptionKeyVersions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .take(remaining);
    for (const version of versions) {
      await ctx.db.delete(version._id);
      keyVersionsDeleted += 1;
      remaining -= 1;
    }
    if (remaining > 0) {
      const custody = await ctx.db
        .query('archiveEncryptionCustody')
        .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
        .take(remaining);
      for (const row of custody) {
        await ctx.db.delete(row._id);
        custodyDeleted += 1;
        remaining -= 1;
      }
    }
    return {
      keyVersionsDeleted,
      custodyDeleted,
      hasMore: remaining === 0,
    };
  },
});

export const eraseArchiveData = internalAction({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const config = erasureConfig();
    let registeredCursor: string | undefined;
    do {
      const result = await callArchiveApi(config, 'ledgers', {
        orgId: args.orgId,
        ledgerIds: [],
        includeRegistered: true,
        ...(registeredCursor === undefined ? {} : { registeredCursor }),
      });
      registeredCursor = result.registeredCursor;
    } while (registeredCursor !== undefined);

    const namespaceId = await resolveArchiveLedgerNamespace(config);
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const query = new URLSearchParams({ limit: String(CLOUDFLARE_OBJECT_PAGE_SIZE) });
      if (cursor !== undefined) query.set('cursor', cursor);
      const envelope = await cloudflareGet<CloudflareObject[]>(
        config,
        `/accounts/${encodeURIComponent(config.accountId)}/workers/durable_objects/namespaces/${encodeURIComponent(namespaceId)}/objects?${query.toString()}`,
      );
      const objects = envelope.result ?? [];
      if (
        objects.some(
          (object) => typeof object.id !== 'string' || !/^[a-f0-9]{64}$/u.test(object.id),
        )
      ) {
        throw new Error('Cloudflare returned an invalid Durable Object id');
      }
      const storedObjects = objects.filter((object) => object.hasStoredData !== false);
      const ledgerIds = storedObjects.map((object) => object.id!);
      if (ledgerIds.length > 0) {
        await callArchiveApi(config, 'ledgers', { orgId: args.orgId, ledgerIds });
      }
      const nextCursor = envelope.result_info?.cursor;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor))
        throw new Error('Cloudflare repeated a Durable Object cursor');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor !== undefined);

    let archiveObjectsRemain = true;
    while (archiveObjectsRemain) {
      const result = await callArchiveApi(config, 'finish', { orgId: args.orgId });
      if (result.erased === undefined) {
        throw new Error('Archive API erasure finish response omitted its completion state');
      }
      archiveObjectsRemain = !result.erased;
    }
    return null;
  },
});
