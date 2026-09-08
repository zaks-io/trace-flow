import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  app,
  archiveSessionPrefix,
  base64,
  checkpoint,
  createExecutionContext,
  exactPrefix,
  fallbackArchiveKeyHttp,
  newLedger,
  observation,
  partFor,
  readLedgerSnapshot,
  readPendingIntent,
  runInDurableObject,
  runtimeEnv,
  scope,
  sha256Hex,
  waitOnExecutionContext,
} from './ledger.integration.fixtures';
import type {
  ArchiveApiEnv,
  ArchiveSessionLedger,
  ArchiveUploadRequest,
} from './ledger.integration.fixtures';

class InfrastructureError extends Error {
  readonly overloaded?: boolean;
  readonly retryable?: boolean;

  constructor(flags: { overloaded?: boolean; retryable?: boolean }) {
    super('Durable Object reset because its code was updated.');
    this.overloaded = flags.overloaded;
    this.retryable = flags.retryable;
  }
}

function infrastructureError(flags: { overloaded?: boolean; retryable?: boolean }): Error {
  return new InfrastructureError(flags);
}

async function uploadHarness(label: string) {
  const currentScope = scope('codex', `${label}-${crypto.randomUUID()}`);
  const collectorSecret = `${label}-collector-secret`;
  const collectorCredentialId = await sha256Hex(collectorSecret);
  await runtimeEnv.COLLECTOR_CREDS.put(
    `collector:${collectorCredentialId}`,
    JSON.stringify({
      orgId: currentScope.orgId,
      userId: currentScope.userId,
      collectorId: `${label}-collector`,
      expiresAt: Date.now() + 3_600_000,
      status: 'active',
      createdAt: Date.now(),
    }),
  );
  const record = await observation(
    currentScope.source,
    currentScope.sourceSessionId,
    partFor(currentScope.source),
    `${label}-record`,
    JSON.stringify({ label }),
  );
  const upload = {
    source_session_id: currentScope.sourceSessionId,
    observations: [record],
    checkpoint: await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [record],
    ),
    complete_prefix_base64: base64(exactPrefix([record])),
  } satisfies ArchiveUploadRequest;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/archive-api/authorize-write') {
      return Response.json({
        allowed: true,
        enrollmentId: `${label}-enrollment`,
        contributionId: currentScope.contributionId,
        orgId: currentScope.orgId,
        userId: currentScope.userId,
        collectorId: `${label}-collector`,
        collectorCredentialId,
      });
    }
    const keyResponse = await fallbackArchiveKeyHttp(url.pathname, currentScope.orgId);
    if (keyResponse) return keyResponse;
    throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
  });
  const send = async (ledger: DurableObjectNamespace<ArchiveSessionLedger>) => {
    const executionContext = createExecutionContext();
    const response = await app.fetch(
      new Request('https://archive.test/v1/archive/uploads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Flow-Collector-Secret': collectorSecret,
          'X-Trace-Flow-Archive-Source': currentScope.source,
        },
        body: JSON.stringify(upload),
      }),
      {
        ...runtimeEnv,
        CONVEX_SITE_URL: 'https://archive-convex.test',
        ARCHIVE_API_SHARED_SECRET: 'archive-api-shared-test-value',
        ARCHIVE_SESSION_LEDGER: ledger,
      },
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    return response;
  };
  return { currentScope, fetchMock, send };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Durable Object infrastructure retries', () => {
  it('uses a fresh stub after a reset before the durable intent', async () => {
    const harness = await uploadHarness('reset-before-intent');
    const realNamespace = runtimeEnv.ARCHIVE_SESSION_LEDGER;
    const reset = infrastructureError({ retryable: true });
    let getCalls = 0;
    const namespace = {
      idFromName: realNamespace.idFromName.bind(realNamespace),
      get(id: DurableObjectId) {
        getCalls += 1;
        const stub = realNamespace.get(id);
        if (getCalls > 1) return stub;
        return {
          fetch: async () => {
            throw reset;
          },
        };
      },
    } as unknown as DurableObjectNamespace<ArchiveSessionLedger>;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const response = await harness.send(namespace);

    expect(response.status).toBe(200);
    expect(getCalls).toBe(2);
    expect(await response.json()).toMatchObject({ generation: 1, record_count: 1 });
    expect(
      await runInDurableObject(newLedger(harness.currentScope), (_instance, state) => ({
        pending: readPendingIntent(state.storage),
        snapshot: readLedgerSnapshot(state.storage),
      })),
    ).toMatchObject({ pending: null, snapshot: { generation: 1, recordCount: 1 } });
    harness.fetchMock.mockRestore();
  });

  it('retains and completes a durable intent after a retryable reset', async () => {
    const harness = await uploadHarness('reset-after-intent');
    const realNamespace = runtimeEnv.ARCHIVE_SESSION_LEDGER;
    const commitReset = new Error('storage reset before the stub boundary');
    const recoveryReset = new Error('recovery reset before the stub boundary');
    const stubReset = infrastructureError({ retryable: true });
    let getCalls = 0;
    const namespace = {
      idFromName: realNamespace.idFromName.bind(realNamespace),
      get(id: DurableObjectId) {
        getCalls += 1;
        const stub = realNamespace.get(id);
        if (getCalls > 1) return stub;
        return {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            await runInDurableObject(stub, async (rawInstance, state) => {
              const instance = rawInstance as ArchiveSessionLedger;
              const mutable = instance as ArchiveSessionLedger & { env: ArchiveApiEnv };
              const originalEnv = mutable.env;
              const originalGetAlarm = state.storage.getAlarm.bind(state.storage);
              let alarmReads = 0;
              const getAlarm = vi.spyOn(state.storage, 'getAlarm').mockImplementation(async () => {
                alarmReads += 1;
                if (alarmReads === 2) throw recoveryReset;
                return originalGetAlarm();
              });
              mutable.env = {
                ...originalEnv,
                STORAGE_BUDGET: {
                  getByName: () => ({
                    reserveStorage: async () => {
                      throw commitReset;
                    },
                  }),
                },
              } as unknown as ArchiveApiEnv;
              try {
                const propagated = await instance.fetch(new Request(input, init)).then(
                  () => undefined,
                  (error: unknown) => error,
                );
                expect(propagated).toBe(commitReset);
                expect(propagated).not.toBe(recoveryReset);
                expect(alarmReads).toBe(2);
                expect(readPendingIntent(state.storage)).toMatchObject({ status: 'ready' });
              } finally {
                getAlarm.mockRestore();
                mutable.env = originalEnv;
              }
            });
            throw stubReset;
          },
        };
      },
    } as unknown as DurableObjectNamespace<ArchiveSessionLedger>;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const response = await harness.send(namespace);

    expect(response.status).toBe(200);
    expect(getCalls).toBe(2);
    expect(await response.json()).toMatchObject({ generation: 1, record_count: 1 });
    const durable = await runInDurableObject(
      newLedger(harness.currentScope),
      (_instance, state) => ({
        pending: readPendingIntent(state.storage),
        snapshot: readLedgerSnapshot(state.storage),
      }),
    );
    expect(durable).toMatchObject({ pending: null, snapshot: { generation: 1, recordCount: 1 } });
    const stored = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: await archiveSessionPrefix(harness.currentScope),
    });
    expect(stored.objects).toHaveLength(2);
    harness.fetchMock.mockRestore();
  });

  it('returns a retryable collector response after exhausting fresh stubs', async () => {
    const harness = await uploadHarness('reset-exhausted');
    const realNamespace = runtimeEnv.ARCHIVE_SESSION_LEDGER;
    const reset = infrastructureError({ retryable: true });
    let getCalls = 0;
    const namespace = {
      idFromName: realNamespace.idFromName.bind(realNamespace),
      get() {
        getCalls += 1;
        return {
          fetch: async () => {
            throw reset;
          },
        };
      },
    } as unknown as DurableObjectNamespace<ArchiveSessionLedger>;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const response = await harness.send(namespace);

    expect(getCalls).toBe(3);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'upload_rejected',
      reason: 'archive_commit_failed',
    });
    harness.fetchMock.mockRestore();
  });

  it.each([
    ['non-retryable', infrastructureError({ retryable: false })],
    ['overloaded', infrastructureError({ overloaded: true, retryable: true })],
  ])('does not retry a %s Durable Object exception', async (label, failure) => {
    const harness = await uploadHarness(`reset-${label}`);
    const realNamespace = runtimeEnv.ARCHIVE_SESSION_LEDGER;
    let getCalls = 0;
    const namespace = {
      idFromName: realNamespace.idFromName.bind(realNamespace),
      get() {
        getCalls += 1;
        return {
          fetch: async () => {
            throw failure;
          },
        };
      },
    } as unknown as DurableObjectNamespace<ArchiveSessionLedger>;

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await harness.send(namespace);

    expect(getCalls).toBe(1);
    expect(response.status).toBe(500);
    harness.fetchMock.mockRestore();
  });
});
