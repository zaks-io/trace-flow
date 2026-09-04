import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import * as Sentry from '@sentry/cloudflare';
import worker, { app } from '../index';
import type { ArchiveApiEnv } from '../context';
import {
  ARCHIVE_API_SENTRY_MAX_REQUEST_BODY_SIZE,
  ARCHIVE_API_SENTRY_REDACTED_HEADERS,
  createArchiveApiSentryOptions,
  redactArchiveApiSentryPayload,
} from '../sentry';

const CONVEX = 'https://convex.test';
const COLLECTOR_SECRET = 'tfc_telemetry_secret_marker_9f3c';
const EXPORT_GRANT = 'archive_export_grant_marker_7a2b';
const RAW_TRANSCRIPT_MARKER = 'RAW_TRANSCRIPT_MARKER_do_not_emit';
const SENTRY_DSN = 'https://publickey@127.0.0.1/1';

function makeKv(): KVNamespace {
  return { get: async () => null } as unknown as KVNamespace;
}

function makeEnvStorage(): R2Bucket {
  return {} as R2Bucket;
}

function makeEnv(): ArchiveApiEnv {
  return {
    COLLECTOR_CREDS: makeKv(),
    CONVEX_SITE_URL: CONVEX,
    ARCHIVE_API_SHARED_SECRET: 'archive-shared-secret',
    ARCHIVE_STORAGE: makeEnvStorage(),
    ARCHIVE_SESSION_LEDGER: {} as DurableObjectNamespace,
    ARCHIVE_KEY_VERSION: '1',
    ARCHIVE_KEY_WRAPPING_SECRET: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    SENTRY_DSN,
  };
}

const forbiddenValues = [COLLECTOR_SECRET, EXPORT_GRANT, RAW_TRANSCRIPT_MARKER];

function assertNoForbiddenTelemetry(serialized: string): void {
  for (const value of forbiddenValues) {
    expect(serialized).not.toContain(value);
  }
}

describe('Archive API Sentry redaction', () => {
  it('disables request-body capture for every route', () => {
    expect(ARCHIVE_API_SENTRY_MAX_REQUEST_BODY_SIZE).toBe('none');
    const options = createArchiveApiSentryOptions(makeEnv());
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(1.0);
    expect(typeof options.integrations).toBe('function');
    const integrations =
      typeof options.integrations === 'function'
        ? options.integrations([
            Sentry.httpServerIntegration({ maxRequestBodySize: 'medium' }),
            Sentry.requestDataIntegration(),
            Sentry.honoIntegration(),
          ])
        : options.integrations;
    const httpServer = integrations?.find((integration) => integration.name === 'HttpServer') as
      | { maxRequestBodySize?: string }
      | undefined;
    expect(httpServer?.maxRequestBodySize).toBe('none');
    expect(integrations?.some((integration) => integration.name === 'Hono')).toBe(true);
  });

  it('strips request bodies and archive credential headers from events and spans', () => {
    const event = redactArchiveApiSentryPayload({
      request: {
        url: 'https://archive.test/v1/archive/uploads',
        method: 'POST',
        data: RAW_TRANSCRIPT_MARKER,
        body: RAW_TRANSCRIPT_MARKER,
        cookies: { session: 'browser' },
        headers: {
          'X-Trace-Flow-Collector-Secret': COLLECTOR_SECRET,
          'X-Trace-Flow-Archive-Export-Grant': EXPORT_GRANT,
          Authorization: 'Bearer pipe-token',
          Cookie: 'appSession=browser',
          'X-Trace-Flow-Archive-Source': 'claude',
        },
      },
      extra: { keep: true },
    });
    expect(event.request).toEqual({
      url: 'https://archive.test/v1/archive/uploads',
      method: 'POST',
      headers: { 'X-Trace-Flow-Archive-Source': 'claude' },
    });
    expect(event.extra).toEqual({ keep: true });
    assertNoForbiddenTelemetry(JSON.stringify(event));

    const span = redactArchiveApiSentryPayload({
      op: 'http.server',
      data: {
        'http.request.method': 'POST',
        'http.request.body.data': RAW_TRANSCRIPT_MARKER,
        'http.request.header.x_trace_flow_collector_secret': COLLECTOR_SECRET,
        'http.request.header.x_trace_flow_archive_export_grant': EXPORT_GRANT,
        'http.request.header.authorization': 'Bearer pipe-token',
        'sentry.op': 'http.server',
      },
    });
    expect(span.data).toEqual({
      'http.request.method': 'POST',
      'sentry.op': 'http.server',
    });
    assertNoForbiddenTelemetry(JSON.stringify(span));
    expect(ARCHIVE_API_SENTRY_REDACTED_HEADERS).toContain('x-trace-flow-collector-secret');
    expect(ARCHIVE_API_SENTRY_REDACTED_HEADERS).toContain('x-trace-flow-archive-export-grant');
  });
});

describe('Archive API Sentry request handling', () => {
  const envelopes: string[] = [];

  beforeEach(() => {
    envelopes.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname.includes('/envelope')) {
        envelopes.push(await req.text());
        return new Response('', { status: 200 });
      }
      if (url.origin === CONVEX) {
        throw new Error(`unexpected convex fetch: ${req.url}`);
      }
      throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function fetchWrapped(path: string, init: RequestInit): Promise<Response> {
    const req = new Request(`https://archive.test${path}`, init);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it('never sends raw upload bytes or archive credentials to Sentry', async () => {
    const upload = await fetchWrapped('/v1/archive/uploads', {
      method: 'POST',
      headers: {
        'X-Trace-Flow-Collector-Secret': COLLECTOR_SECRET,
        'X-Trace-Flow-Archive-Source': 'claude',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transcript: RAW_TRANSCRIPT_MARKER }),
    });
    expect(upload.status).toBe(401);

    const exported = await fetchWrapped('/v1/archive/exports', {
      method: 'POST',
      headers: { 'X-Trace-Flow-Archive-Export-Grant': EXPORT_GRANT },
    });
    expect(exported.status).toBe(403);

    const deleted = await fetchWrapped('/v1/archive', {
      method: 'DELETE',
      headers: { 'X-Trace-Flow-Archive-Export-Grant': EXPORT_GRANT },
    });
    expect(deleted.status).toBe(403);

    expect(envelopes.length).toBeGreaterThan(0);
    assertNoForbiddenTelemetry(envelopes.join('\n'));
  });

  it('keeps authorization behavior on the unwrapped app used by unit tests', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://archive.test/v1/archive/uploads', {
        method: 'POST',
        headers: { 'X-Trace-Flow-Archive-Source': 'claude' },
      }),
      makeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'missing' });
  });
});
