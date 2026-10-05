import { setAsyncLocalStorageAsyncContextStrategy } from '@sentry/cloudflare';
import {
  captureException,
  createStackParser,
  getCurrentScope,
  nodeStackLineParser,
  ServerRuntimeClient,
  setAsyncContextStrategy,
  startNewTrace,
  startSpan,
  withIsolationScope,
  withScope,
  type Envelope,
  type Event,
  type Span,
} from '@sentry/core';
import { createLogger, recordFromLogger, type Logger, type LogRecord } from './index';

const DOMAIN_TRACE_ID = '0123456789abcdef0123456789abcdef';
const clients: ServerRuntimeClient[] = [];

function recordingLogger(axiom = false): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const emit = (value: unknown) => records.push(JSON.parse(String(value)) as LogRecord);
  return {
    records,
    logger: createLogger({
      service: 'test',
      runtime: 'cloudflare-worker',
      context: { traceId: DOMAIN_TRACE_ID },
      console: { debug: emit, info: emit, warn: emit, error: emit },
      axiom: axiom ? { token: 'test-token', dataset: 'test-dataset' } : undefined,
    }),
  };
}

function operationalIdentity(span: Span): Partial<LogRecord> {
  const { traceId, spanId } = span.spanContext();
  return { sentry_trace_id: traceId, sentry_span_id: spanId };
}

function withClient<T>(
  callback: (client: ServerRuntimeClient, envelopes: Envelope[]) => T,
  tracesSampleRate = 1,
): T {
  const envelopes: Envelope[] = [];
  const client = new ServerRuntimeClient({
    dsn: 'https://public@example.test/1',
    integrations: [],
    stackParser: createStackParser(nodeStackLineParser()),
    tracesSampleRate,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  clients.push(client);
  client.init();
  return withIsolationScope(() =>
    withScope((scope) => {
      scope.setClient(client);
      return callback(client, envelopes);
    }),
  );
}

describe('Sentry operational log context', () => {
  it('honors an isolated explicit scope at emission and on child loggers', () => {
    const records: LogRecord[] = [];
    const emit = (value: unknown) => records.push(JSON.parse(String(value)) as LogRecord);
    let context: { traceId: string; spanId: string } | undefined = {
      traceId: DOMAIN_TRACE_ID,
      spanId: '1111111111111111',
    };
    const logger = createLogger({
      service: 'convex',
      runtime: 'convex',
      sentrySpanContext: () => context,
      console: { debug: emit, info: emit, warn: emit, error: emit },
    });
    logger.info('before');
    context = { traceId: '22222222222222222222222222222222', spanId: '2222222222222222' };
    logger.child({ component: 'query' }).info('after');
    context = undefined;
    logger.info('outside');
    expect(records[0]?.sentry_trace_id).toBe(DOMAIN_TRACE_ID);
    expect(records[1]?.sentry_trace_id).toBe('22222222222222222222222222222222');
    expect(records[2]).not.toHaveProperty('sentry_trace_id');
  });
  beforeEach(() => {
    setAsyncLocalStorageAsyncContextStrategy();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose();
    setAsyncContextStrategy(undefined);
    vi.unstubAllGlobals();
  });

  it('reads the active span when a long-lived logger emits, preserving domain identity', () => {
    withClient(() => {
      let logger!: Logger;
      let records!: LogRecord[];
      startNewTrace(() =>
        startSpan({ name: 'first request' }, (first) => {
          ({ logger, records } = recordingLogger());
          expect(first.isRecording()).toBe(true);
          logger.info('first');
          expect(records[0]).toMatchObject(operationalIdentity(first));
        }),
      );
      startNewTrace(() =>
        startSpan({ name: 'second request' }, (second) => {
          logger.child({ requestId: 'second' }).info('second');
          expect(records[1]).toMatchObject(operationalIdentity(second));
        }),
      );
      logger.info('outside');

      expect(records.map((record) => record.trace_id)).toEqual([
        DOMAIN_TRACE_ID,
        DOMAIN_TRACE_ID,
        DOMAIN_TRACE_ID,
      ]);
      expect(records[0]?.sentry_trace_id).not.toBe(records[1]?.sentry_trace_id);
      expect(records[2]).not.toHaveProperty('sentry_trace_id');
      expect(records[2]).not.toHaveProperty('sentry_span_id');
    });
  });

  it('uses the nested processing span and restores its parent after it ends', () => {
    withClient(() => {
      const { logger, records } = recordingLogger();
      startSpan({ name: 'request' }, (parent) => {
        logger.info('parent.before');
        startSpan({ name: 'processing' }, (child) => {
          logger.error('processing.failed', new Error('failed processing'));
          expect(records[1]).toMatchObject({
            ...operationalIdentity(child),
            error_name: 'Error',
            error_message: 'failed processing',
          });
          expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
          expect(child.spanContext().spanId).not.toBe(parent.spanContext().spanId);
        });
        logger.info('parent.after');
        expect(records[0]).toMatchObject(operationalIdentity(parent));
        expect(records[2]).toMatchObject(operationalIdentity(parent));
      });
    });
  });

  it('retains separate trace identities while concurrent request scopes overlap', async () => {
    await withClient(async () => {
      const { logger, records } = recordingLogger();
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const firstCanResume = new Promise<void>((resolve) => (releaseFirst = resolve));
      const secondCanResume = new Promise<void>((resolve) => (releaseSecond = resolve));
      const identities: Partial<LogRecord>[] = [];

      const first = startNewTrace(() =>
        startSpan({ name: 'first request' }, async (span) => {
          identities[0] = operationalIdentity(span);
          logger.info('first.before');
          await firstCanResume;
          logger.error('first.after', new Error('first error'));
          releaseSecond();
        }),
      );
      const second = startNewTrace(() =>
        startSpan({ name: 'second request' }, async (span) => {
          identities[1] = operationalIdentity(span);
          logger.info('second.before');
          releaseFirst();
          await secondCanResume;
          logger.info('second.after');
        }),
      );
      await Promise.all([first, second]);

      expect(identities[0]?.sentry_trace_id).not.toBe(identities[1]?.sentry_trace_id);
      for (const record of records) {
        expect(record).toMatchObject(
          record.event.startsWith('first.') ? identities[0]! : identities[1]!,
        );
      }
      expect(records.map((record) => record.event)).toEqual([
        'first.before',
        'second.before',
        'first.after',
        'second.after',
      ]);
    });
  });

  it('includes valid operational IDs for an unsampled active span', () => {
    withClient(() => {
      startSpan({ name: 'unsampled request' }, (span) => {
        expect(span.isRecording()).toBe(false);
        expect(span.spanContext().traceFlags).toBe(0);
        const record = recordFromLogger('test', 'cloudflare-worker', 'info', 'unsampled');
        expect(record).toMatchObject(operationalIdentity(span));
        expect(record.sentry_trace_id).toMatch(/^[a-f0-9]{32}$/);
        expect(record.sentry_span_id).toMatch(/^[a-f0-9]{16}$/);
      });
    }, 0);
  });

  it('does not invent active-span identity from a scope propagation context', () => {
    withClient(() => {
      getCurrentScope().setPropagationContext({
        traceId: DOMAIN_TRACE_ID,
        sampleRand: 0.5,
      });
      const record = recordFromLogger('test', 'cloudflare-worker', 'info', 'no.active.span');
      expect(record).not.toHaveProperty('sentry_trace_id');
      expect(record).not.toHaveProperty('sentry_span_id');
    });
  });

  it('agrees with Sentry errors and sends the same identity to console and Axiom', async () => {
    await withClient(async (client, envelopes) => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const { logger, records } = recordingLogger(true);
      const error = new Error('captured operation failed');
      startSpan({ name: 'processing' }, (span) => {
        logger.error('operation.failed', error);
        captureException(error);
        expect(records[0]).toMatchObject(operationalIdentity(span));
      });
      await client.flush(1000);
      await logger.flush();

      const errorEvents = envelopes.flatMap(([, items]) =>
        items.filter(([header]) => header.type === 'event').map(([, payload]) => payload as Event),
      );
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]?.contexts?.trace).toMatchObject({
        trace_id: records[0]?.sentry_trace_id,
        span_id: records[0]?.sentry_span_id,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual(records);
    });
  });
});
