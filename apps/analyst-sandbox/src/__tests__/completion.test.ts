import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  getSandbox: vi.fn(),
  getPricing: vi.fn(),
}));

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    action = mocks.action;
  },
}));

vi.mock('@cloudflare/sandbox', () => ({
  ContainerProxy: class {
    fetch() {
      return new Response('unused');
    }
  },
  Sandbox: class {},
  getSandbox: mocks.getSandbox,
}));

vi.mock('@trace-flow/pricing', () => ({
  getPricing: mocks.getPricing,
}));

import worker from '../index';

function completionRequest() {
  return new Request('https://sandbox.example/pi-runs/complete', {
    method: 'POST',
    headers: {
      authorization: 'Bearer run-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      runId: 'n7b9x8y2c1d0e3f4g5h6i7j8k9l0m1n',
      sandboxId: 'caller-selected-sandbox',
      status: 'completed',
    }),
  });
}

describe('Pi completion callback', () => {
  beforeEach(() => {
    mocks.action.mockReset();
    mocks.getSandbox.mockReset();
    mocks.getPricing.mockReset();
  });

  it('treats terminal retries as idempotent without touching a sandbox', async () => {
    mocks.action.mockResolvedValue({
      ok: true,
      terminalReplay: true,
      sandboxId: 'stored-sandbox',
      allowSnapshot: false,
    });
    const waitUntil = vi.fn();
    const env = { CONVEX_URL: 'https://convex.example' };
    const ctx = { waitUntil, passThroughOnException: vi.fn() };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await worker.fetch(completionRequest(), env as never, ctx as never);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    }

    expect(mocks.action).toHaveBeenCalledTimes(2);
    expect(mocks.getSandbox).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('retries terminal backup cleanup until deletion is acknowledged', async () => {
    mocks.action
      .mockResolvedValueOnce({
        ok: true,
        terminalReplay: true,
        sandboxId: 'stored-sandbox',
        allowSnapshot: false,
        backupIdsToDelete: ['snapshots/org_1/old.sqfs'],
      })
      .mockResolvedValueOnce({
        ok: true,
        terminalReplay: true,
        sandboxId: 'stored-sandbox',
        allowSnapshot: false,
        backupIdsToDelete: ['snapshots/org_1/old.sqfs'],
      })
      .mockResolvedValueOnce(null);
    const deleteObject = vi
      .fn()
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockResolvedValueOnce(undefined);
    const env = {
      CONVEX_URL: 'https://convex.example',
      BACKUP_BUCKET: { delete: deleteObject },
    };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

    const failed = await worker.fetch(completionRequest(), env as never, ctx as never);
    expect(failed.status).toBe(502);

    const retried = await worker.fetch(completionRequest(), env as never, ctx as never);
    expect(retried.status).toBe(200);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(mocks.action).toHaveBeenCalledTimes(3);
  });

  it('does not touch a sandbox when another completion owns the lease', async () => {
    mocks.action.mockResolvedValue({ ok: false, reason: 'in_progress' });
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      completionRequest(),
      { CONVEX_URL: 'https://convex.example' } as never,
      { waitUntil, passThroughOnException: vi.fn() } as never,
    );

    expect(response.status).toBe(409);
    expect(mocks.getSandbox).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('cleans pending checkpoint backups before returning an authorization denial', async () => {
    mocks.action
      .mockResolvedValueOnce({
        ok: false,
        reason: 'unauthorized',
        backupIdsToDelete: ['snapshots/org_1/orphan.sqfs'],
      })
      .mockResolvedValueOnce(null);
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const request = new Request('https://sandbox.example/pi-runs/checkpoint', {
      method: 'POST',
      headers: {
        authorization: 'Bearer run-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ runId: 'n7b9x8y2c1d0e3f4g5h6i7j8k9l0m1n' }),
    });

    const response = await worker.fetch(
      request,
      {
        CONVEX_URL: 'https://convex.example',
        BACKUP_BUCKET: { delete: deleteObject },
      } as never,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never,
    );

    expect(response.status).toBe(401);
    expect(deleteObject).toHaveBeenCalledWith(['snapshots/org_1/orphan.sqfs']);
    expect(mocks.action).toHaveBeenCalledTimes(2);
  });

  it('uses the stored sandbox id for accepted completion cleanup', async () => {
    const setKeepAlive = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getSandbox.mockReturnValue({ setKeepAlive, destroy });
    mocks.action
      .mockResolvedValueOnce({
        ok: true,
        terminalReplay: false,
        sandboxId: 'stored-sandbox',
        reservation: 1,
        allowSnapshot: false,
      })
      .mockResolvedValueOnce({ ok: true, transitioned: true });
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      completionRequest(),
      { CONVEX_URL: 'https://convex.example' } as never,
      { waitUntil, passThroughOnException: vi.fn() } as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.getSandbox.mock.calls.map((call) => call[1])).toEqual(['stored-sandbox']);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('stores snapshots under the organization prefix and deletes the replaced object', async () => {
    const setKeepAlive = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: '128', stderr: '' }),
      readFileStream: vi.fn().mockResolvedValue(new ReadableStream()),
      setKeepAlive,
      destroy,
    };
    mocks.getSandbox.mockReturnValue(sandbox);
    const put = vi.fn().mockResolvedValue({});
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    mocks.action
      .mockResolvedValueOnce({
        ok: true,
        terminalReplay: false,
        sandboxId: 'stored-sandbox',
        orgId: 'org_1',
        reservation: 1,
        allowSnapshot: true,
      })
      .mockImplementationOnce(async (_ref, args) => ({
        ok: true,
        transitioned: true,
        backupIdsToDelete: ['snapshots/legacy/old.sqfs'],
        acceptedBackupId: args.backup.id,
      }));

    const response = await worker.fetch(
      completionRequest(),
      {
        CONVEX_URL: 'https://convex.example',
        BACKUP_BUCKET: { put, delete: deleteObject },
      } as never,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never,
    );

    expect(response.status).toBe(200);
    const [key, , options] = put.mock.calls[0]!;
    expect(key).toMatch(/^snapshots\/org_1\/stored-sandbox\/.+\.sqfs$/u);
    expect(Number(options.customMetadata.expiresAt)).toBeGreaterThan(Date.now());
    expect(deleteObject).toHaveBeenCalledWith(['snapshots/legacy/old.sqfs']);
  });

  it('deletes the new snapshot when the bounded commit attempts fail', async () => {
    const sandbox = {
      exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: '128', stderr: '' }),
      readFileStream: vi.fn().mockResolvedValue(new ReadableStream()),
    };
    mocks.getSandbox.mockReturnValue(sandbox);
    const put = vi.fn().mockResolvedValue({});
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    mocks.action
      .mockResolvedValueOnce({
        ok: true,
        terminalReplay: false,
        sandboxId: 'stored-sandbox',
        orgId: 'org_1',
        reservation: 1,
        allowSnapshot: true,
      })
      .mockRejectedValue(new Error('Convex unavailable'));

    const response = await worker.fetch(
      completionRequest(),
      {
        CONVEX_URL: 'https://convex.example',
        BACKUP_BUCKET: { put, delete: deleteObject },
      } as never,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never,
    );

    expect(response.status).toBe(502);
    expect(mocks.action).toHaveBeenCalledTimes(3);
    const newBackupId = put.mock.calls[0]?.[0] as string;
    expect(deleteObject).toHaveBeenCalledWith([newBackupId]);
  });
});

describe('Analyst backup lifecycle', () => {
  beforeEach(() => {
    mocks.action.mockReset();
    mocks.getSandbox.mockReset();
    mocks.getPricing.mockReset();
  });

  it('deletes an expired snapshot and starts cold without restoring it', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = {
      writeFile,
      mkdir: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      startProcess: vi.fn().mockResolvedValue({ id: 'process-1', pid: 42 }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getSandbox.mockReturnValue(sandbox);
    mocks.getPricing.mockResolvedValue({
      promptCostPerMillion: 1,
      completionCostPerMillion: 1,
      updatedAt: 1,
      source: 'manual',
    });
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const backupId = 'snapshots/legacy/expired.sqfs';
    const request = new Request('https://sandbox.example/pi-runs/start', {
      method: 'POST',
      headers: {
        authorization: 'Bearer shared-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        runId: 'run-1',
        runToken: 'a'.repeat(64),
        sandboxId: 'sandbox-1',
        prompt: 'Analyze',
        pageContextReferences: [],
        maxRuntimeMs: 60_000,
        model: 'test/model',
        toolDefinitions: [],
        resume: true,
        backup: { id: backupId, dir: '/workspace' },
      }),
    });

    const response = await worker.fetch(
      request,
      {
        ANALYST_SANDBOX_SHARED_SECRET: 'shared-secret',
        BACKUP_BUCKET: {
          get: vi.fn().mockResolvedValue({
            body: new ReadableStream(),
            customMetadata: { expiresAt: String(Date.now() - 1) },
          }),
          delete: deleteObject,
        },
        MODEL_PRICING: {},
      } as never,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never,
    );

    expect(response.status).toBe(200);
    expect(deleteObject).toHaveBeenCalledWith(backupId);
    expect(writeFile).not.toHaveBeenCalledWith('/tmp/traceflow-workspace.sqfs', expect.anything());
    const requestWrite = writeFile.mock.calls.find(([path]) =>
      String(path).endsWith('/request.json'),
    );
    expect(JSON.parse(String(requestWrite?.[1])).resume).toBe(false);
  });

  it('requires internal authority and deletes every org-prefixed object page', async () => {
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const list = vi.fn().mockResolvedValue({
      objects: [{ key: 'snapshots/org_1/sandbox/one.sqfs' }],
      truncated: false,
    });
    const env = {
      ANALYST_SANDBOX_SHARED_SECRET: 'shared-secret',
      BACKUP_BUCKET: { delete: deleteObject, list },
    };
    const unauthorized = await worker.fetch(
      new Request('https://sandbox.example/internal/backups/erase', {
        method: 'POST',
        body: JSON.stringify({ orgId: 'org_1' }),
      }),
      env as never,
      {} as never,
    );
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(
      new Request('https://sandbox.example/internal/backups/erase', {
        method: 'POST',
        headers: {
          authorization: 'Bearer shared-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ orgId: 'org_1' }),
      }),
      env as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, erased: true });
    expect(list).toHaveBeenCalledWith({ prefix: 'snapshots/org_1/', limit: 1000 });
    expect(deleteObject).toHaveBeenCalledWith(['snapshots/org_1/sandbox/one.sqfs']);
  });
});
