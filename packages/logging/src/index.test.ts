import { formatTraceparent } from '@trace-flow/utils';
import {
  createLogger,
  recordFromLogger,
  serializeError,
  traceContextFromHeaders,
  traceContextToHeaders,
  type LogRecord,
} from './index';

describe('serializeError', () => {
  it('serializes Error instances', () => {
    const error = new Error('boom');
    error.name = 'CustomError';

    expect(serializeError(error)).toMatchObject({
      error_name: 'CustomError',
      error_message: 'boom',
    });
  });

  it('serializes plain strings', () => {
    expect(serializeError('oops')).toEqual({
      error_message: 'oops',
    });
  });
});

describe('trace context headers', () => {
  it('round-trips trace context with baggage fields', () => {
    const headers = traceContextToHeaders({
      traceId: '0123456789abcdef0123456789abcdef',
      parentSpanId: '0123456789abcdef',
      traceState: 'vendor=value',
      requestId: 'req_123',
      workflowId: 'wf_123',
      orgId: 'org_123',
      userId: 'user_123',
      sessionId: 'session_123',
      baggage: { feature: 'billing' },
    });

    expect(traceContextFromHeaders(headers)).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      parentSpanId: '0123456789abcdef',
      traceState: 'vendor=value',
      traceFlags: 1,
      requestId: 'req_123',
      workflowId: 'wf_123',
      orgId: 'org_123',
      userId: 'user_123',
      sessionId: 'session_123',
      baggage: { feature: 'billing' },
    });
  });

  it('parses an existing traceparent header', () => {
    const headers = new Headers({
      traceparent: formatTraceparent('fedcba9876543210fedcba9876543210', '0123456789abcdef', 0x00),
    });

    expect(traceContextFromHeaders(headers)).toEqual({
      traceId: 'fedcba9876543210fedcba9876543210',
      parentSpanId: '0123456789abcdef',
      traceFlags: 0,
    });
  });
});

describe('recordFromLogger', () => {
  it('maps context fields into the shared schema', () => {
    expect(
      recordFromLogger(
        'proxy',
        'cloudflare-worker',
        'info',
        'proxy.request_received',
        {
          component: 'gateway',
          operation: 'chat',
          route: '/openai/v1/chat/completions',
          method: 'POST',
          traceId: '0123456789abcdef0123456789abcdef',
          requestId: 'req_123',
          orgId: 'org_123',
          cfRay: 'ray_123',
        },
        { provider: 'openai' },
      ),
    ).toMatchObject({
      level: 'info',
      event: 'proxy.request_received',
      service: 'proxy',
      runtime: 'cloudflare-worker',
      component: 'gateway',
      operation: 'chat',
      route: '/openai/v1/chat/completions',
      method: 'POST',
      trace_id: '0123456789abcdef0123456789abcdef',
      request_id: 'req_123',
      org_id: 'org_123',
      cf_ray: 'ray_123',
      data: { provider: 'openai' },
    });
  });
});

describe('createLogger', () => {
  it('merges child context into emitted records', () => {
    const messages: string[] = [];
    const logger = createLogger({
      service: 'api',
      runtime: 'cloudflare-worker',
      emitToConsole: true,
      console: {
        debug: (value) => messages.push(String(value)),
        info: (value) => messages.push(String(value)),
        warn: (value) => messages.push(String(value)),
        error: (value) => messages.push(String(value)),
      },
      context: {
        traceId: '0123456789abcdef0123456789abcdef',
      },
    });

    logger.child({ requestId: 'req_123', orgId: 'org_123' }).info('api.request_complete', {
      status: 200,
    });

    expect(JSON.parse(messages[0] ?? '{}')).toMatchObject({
      event: 'api.request_complete',
      trace_id: '0123456789abcdef0123456789abcdef',
      request_id: 'req_123',
      org_id: 'org_123',
      data: { status: 200 },
    });
  });
});

describe('batch transport', () => {
  let fetchCalls: { url: string; body: string }[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(null, { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('buffers records and sends as array on flush', async () => {
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
    });

    logger.info('event.one');
    logger.info('event.two');
    logger.warn('event.three');

    // No fetch calls yet — records are buffered
    expect(fetchCalls).toHaveLength(0);

    await logger.flush();

    expect(fetchCalls).toHaveLength(1);
    const sent = JSON.parse(fetchCalls[0]!.body) as LogRecord[];
    expect(sent).toHaveLength(3);
    expect(sent[0]!.event).toBe('event.one');
    expect(sent[1]!.event).toBe('event.two');
    expect(sent[2]!.event).toBe('event.three');
  });

  it('flush is a no-op when buffer is empty', async () => {
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
    });

    await logger.flush();

    expect(fetchCalls).toHaveLength(0);
  });

  it('falls back to console on transport error', async () => {
    globalThis.fetch = async () => new Response('rate limited', { status: 429 });

    const errors: string[] = [];
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
      console: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (value) => errors.push(String(value)),
      },
    });

    logger.info('event.one');
    await logger.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('axiom_ingest_failed');
  });

  it('child loggers share the same buffer', async () => {
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
    });

    const child = logger.child({ component: 'child' });
    logger.info('parent.event');
    child.info('child.event');

    await child.flush();

    expect(fetchCalls).toHaveLength(1);
    const sent = JSON.parse(fetchCalls[0]!.body) as LogRecord[];
    expect(sent).toHaveLength(2);
    expect(sent[0]!.event).toBe('parent.event');
    expect(sent[1]!.event).toBe('child.event');
    expect(sent[1]!.component).toBe('child');
  });

  it('flush from child flushes all records including parent', async () => {
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
    });

    logger.info('before.child');
    const child = logger.child({ requestId: 'req_1' });
    child.error('child.error', new Error('boom'));

    // Flush from parent — should include all records
    await logger.flush();

    expect(fetchCalls).toHaveLength(1);
    const sent = JSON.parse(fetchCalls[0]!.body) as LogRecord[];
    expect(sent).toHaveLength(2);
    expect(sent[1]!.error_message).toBe('boom');
  });

  it('flush without axiom config resolves immediately', async () => {
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
    });

    logger.info('event.one');
    await logger.flush();

    expect(fetchCalls).toHaveLength(0);
  });

  it('restores records to buffer on flush failure', async () => {
    let shouldFail = true;
    globalThis.fetch = async () => {
      if (shouldFail) return new Response('server error', { status: 500 });
      return new Response(null, { status: 200 });
    };

    const errors: string[] = [];
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
      console: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (value) => errors.push(String(value)),
      },
    });

    logger.info('event.one');
    logger.info('event.two');
    await logger.flush();

    // First flush failed — records should be restored
    expect(errors).toHaveLength(1);

    // Retry with working fetch — records should be sent
    shouldFail = false;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(null, { status: 200 });
    };

    await logger.flush();

    expect(fetchCalls).toHaveLength(1);
    const sent = JSON.parse(fetchCalls[0]!.body) as LogRecord[];
    expect(sent).toHaveLength(2);
    expect(sent[0]!.event).toBe('event.one');
    expect(sent[1]!.event).toBe('event.two');
  });

  it('concurrent flush calls do not lose records', async () => {
    let resolveFirst: () => void;
    let callCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First flush: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(null, { status: 200 });
    };

    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
    });

    logger.info('event.one');

    // Start first flush (will block on fetch)
    const flush1 = logger.flush();

    // Enqueue another record while first flush is in-flight
    logger.info('event.two');

    // Start second flush — should wait for first, then flush new records
    const flush2 = logger.flush();

    // Release the first fetch
    resolveFirst!();

    await Promise.all([flush1, flush2]);

    // Should have two separate fetch calls
    expect(fetchCalls).toHaveLength(2);

    const firstBatch = JSON.parse(fetchCalls[0]!.body) as LogRecord[];
    expect(firstBatch).toHaveLength(1);
    expect(firstBatch[0]!.event).toBe('event.one');

    const secondBatch = JSON.parse(fetchCalls[1]!.body) as LogRecord[];
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0]!.event).toBe('event.two');
  });

  it('three concurrent flush calls serialize correctly', async () => {
    let resolveFirst: () => void;
    let callCount = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(null, { status: 200 });
    };

    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
    });

    logger.info('event.one');
    const flush1 = logger.flush();

    logger.info('event.two');
    const flush2 = logger.flush();
    const flush3 = logger.flush();

    resolveFirst!();
    await Promise.all([flush1, flush2, flush3]);

    // flush1 sends event.one, flush2 sends event.two, flush3 hits empty buffer (no-op)
    expect(fetchCalls).toHaveLength(2);

    const allSent = fetchCalls.flatMap((call) => JSON.parse(call.body) as LogRecord[]);
    const events = allSent.map((r) => r.event);
    expect(events).toEqual(['event.one', 'event.two']);
  });

  it('preserves order when records enqueued during a failing fetch', async () => {
    let fetchStarted: () => void;
    const fetchStartedPromise = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });

    globalThis.fetch = async () => {
      fetchStarted!();
      return new Response('server error', { status: 500 });
    };

    const errors: string[] = [];
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
      console: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (value) => errors.push(String(value)),
      },
    });

    logger.info('event.one');
    logger.info('event.two');

    const flushPromise = logger.flush();

    // Wait for fetch to start, then enqueue during in-flight request
    await fetchStartedPromise;
    logger.info('event.three');

    await flushPromise;
    expect(errors).toHaveLength(1);

    // Retry with working fetch — all three records in order
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(null, { status: 200 });
    };

    await logger.flush();

    expect(fetchCalls).toHaveLength(1);
    const sent = JSON.parse(fetchCalls[0]!.body) as LogRecord[];
    expect(sent).toHaveLength(3);
    expect(sent[0]!.event).toBe('event.one');
    expect(sent[1]!.event).toBe('event.two');
    expect(sent[2]!.event).toBe('event.three');
  });

  it('concurrent waiter retries after flush failure restores records', async () => {
    let callCount = 0;
    let resolveFirst: () => void;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // Block so flush2 can park in while(flushing)
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return new Response('server error', { status: 500 });
      }
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(null, { status: 200 });
    };

    const errors: string[] = [];
    const logger = createLogger({
      service: 'test',
      runtime: 'node',
      emitToConsole: false,
      axiom: { token: 'test-token', dataset: 'test-ds' },
      console: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (value) => errors.push(String(value)),
      },
    });

    logger.info('event.one');
    logger.info('event.two');

    // flush1 starts, blocks on fetch
    const flush1 = logger.flush();
    // flush2 parks in while(flushing)
    const flush2 = logger.flush();

    // Release flush1 — it fails, restores records, flush2 acquires lock
    resolveFirst!();
    await Promise.all([flush1, flush2]);

    expect(errors).toHaveLength(1);
    expect(fetchCalls).toHaveLength(1);

    const sent = JSON.parse(fetchCalls[0]!.body) as LogRecord[];
    expect(sent).toHaveLength(2);
    expect(sent[0]!.event).toBe('event.one');
    expect(sent[1]!.event).toBe('event.two');
  });
});
