import { describe, expect, it, vi } from 'vitest';
import {
  base64,
  call,
  checkpoint,
  envelope,
  exactPrefix,
  newLedger,
  observation,
  partFor,
  readLedgerSnapshot,
  readPendingIntent,
  runInDurableObject,
  scope,
} from './ledger.integration.fixtures';
import type {
  ArchiveApiEnv,
  ArchiveSessionLedger,
  ArchiveUploadRequest,
} from './ledger.integration.fixtures';

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

describe('Archive Session Ledger overlapping fetch recovery', () => {
  it('keeps the commit queue usable after recovery alarm arming fails', async () => {
    const currentScope = scope('codex', `alarm-arm-failure-${crypto.randomUUID()}`);
    const record = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'alarm-arm-record',
      '{"record":1}',
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
    const request = await envelope(currentScope, upload);
    const ledger = newLedger(currentScope);

    const result = await runInDurableObject(
      ledger,
      async (instance: ArchiveSessionLedger, state) => {
        const getAlarm = vi
          .spyOn(state.storage, 'getAlarm')
          .mockRejectedValueOnce(new Error('alarm_read_failed'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          const first = await instance.fetch(
            new Request('https://ledger.test/commit', {
              method: 'POST',
              body: JSON.stringify(request),
            }),
          );
          const second = await instance.fetch(
            new Request('https://ledger.test/commit', {
              method: 'POST',
              body: JSON.stringify(request),
            }),
          );
          return {
            statuses: [first.status, second.status],
            checkpoint: readLedgerSnapshot(state.storage),
          };
        } finally {
          getAlarm.mockRestore();
          consoleError.mockRestore();
        }
      },
    );

    expect(result.statuses).toEqual([500, 200]);
    expect(result.checkpoint.generation).toBe(1);
  });

  it('arms recovery inside the queued turn before a second fetch persists an intent', async () => {
    const currentScope = scope('codex', `overlapping-fetch-${crypto.randomUUID()}`);
    const first = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'overlapping-first',
      '{"record":1}',
    );
    const firstUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [first],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [first],
      ),
      complete_prefix_base64: base64(exactPrefix([first])),
    } satisfies ArchiveUploadRequest;
    const firstRequest = await envelope(currentScope, firstUpload);
    const ledger = newLedger(currentScope);
    await expect(call(ledger, firstRequest)).resolves.toMatchObject({
      response: { status: 200 },
    });

    const second = await observation(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      'overlapping-second',
      '{"record":2}',
    );
    const secondUpload = {
      source_session_id: currentScope.sourceSessionId,
      observations: [first, second],
      checkpoint: await checkpoint(
        currentScope.source,
        currentScope.sourceSessionId,
        partFor(currentScope.source),
        [first, second],
      ),
      complete_prefix_base64: base64(exactPrefix([first, second])),
    } satisfies ArchiveUploadRequest;
    const secondRequest = await envelope(currentScope, secondUpload);

    const result = await runInDurableObject(
      ledger,
      async (instance: ArchiveSessionLedger, state) => {
        const mutable = instance as unknown as {
          env: ArchiveApiEnv;
          commitQueue: Promise<void>;
        };
        const originalEnv = mutable.env;
        const existingRead = deferred();
        const releaseExistingRead = deferred();
        const newRead = deferred();
        const releaseNewRead = deferred();
        let blockedExisting = false;
        let blockedNew = false;
        let interrupting = true;
        const bucket = originalEnv.ARCHIVE_STORAGE;
        mutable.env = {
          ...originalEnv,
          ARCHIVE_STORAGE: {
            get: async (key: string) => {
              const object = await bucket.get(key);
              if (object && !blockedExisting) {
                blockedExisting = true;
                existingRead.resolve();
                await releaseExistingRead.promise;
              } else if (!object && !blockedNew) {
                blockedNew = true;
                newRead.resolve();
                await releaseNewRead.promise;
                throw new Error('second_fetch_interrupted');
              }
              return object;
            },
            head: async (key: string) => {
              if (interrupting) throw new Error('inventory_ambiguous');
              return bucket.head(key);
            },
            put: bucket.put.bind(bucket),
          } as unknown as R2Bucket,
        };

        const firstFetch = instance.fetch(
          new Request('https://ledger.test/commit', {
            method: 'POST',
            body: JSON.stringify(firstRequest),
          }),
        );
        await existingRead.promise;
        const firstTurn = mutable.commitQueue;
        const secondFetch = instance.fetch(
          new Request('https://ledger.test/commit', {
            method: 'POST',
            body: JSON.stringify(secondRequest),
          }),
        );
        for (let attempt = 0; mutable.commitQueue === firstTurn && attempt < 20; attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        expect(mutable.commitQueue).not.toBe(firstTurn);
        releaseExistingRead.resolve();
        await newRead.promise;

        const interrupted = {
          pending: readPendingIntent(state.storage),
          alarm: await state.storage.getAlarm(),
        };
        releaseNewRead.resolve();
        const [firstResponse, secondResponse] = await Promise.all([firstFetch, secondFetch]);
        interrupting = false;
        mutable.env = originalEnv;
        await instance.alarm();
        return {
          interrupted,
          statuses: [firstResponse.status, secondResponse.status],
          recovered: {
            pending: readPendingIntent(state.storage),
            checkpoint: readLedgerSnapshot(state.storage),
            alarm: await state.storage.getAlarm(),
          },
        };
      },
    );

    expect(result.interrupted.pending).toMatchObject({ status: 'write_authorized' });
    expect(result.interrupted.alarm).not.toBeNull();
    expect(result.statuses).toEqual([200, 500]);
    expect(result.recovered.pending).toBeNull();
    expect(result.recovered.checkpoint.generation).toBe(2);
    expect(result.recovered.alarm).toBeNull();
  });
});
