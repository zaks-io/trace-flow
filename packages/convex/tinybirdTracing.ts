import { createTransport, Scope, ServerRuntimeClient } from '@sentry/core';
import {
  fetchPipe as fetchPipeCore,
  runAdminSql as runAdminSqlCore,
  type FetchPipeOptions,
  type RunAdminSqlOptions,
} from '@trace-flow/tinybird-client';

export async function withTinybirdTracing<T>(callback: (scope: Scope) => Promise<T>): Promise<T> {
  const dsn = process.env.SENTRY_DSN;
  const environment = process.env.SENTRY_ENVIRONMENT;
  if (!dsn || !environment) {
    throw new Error('Tinybird tracing requires SENTRY_DSN and SENTRY_ENVIRONMENT');
  }

  // Each action owns its client and scope; concurrent actions must not share trace context.
  const client = new ServerRuntimeClient({
    dsn,
    environment,
    tracesSampleRate: 1,
    integrations: [],
    stackParser: () => [],
    sendDefaultPii: false,
    transport: (options) =>
      createTransport(options, async (request) => {
        const response = await fetch(options.url, {
          method: 'POST',
          body:
            typeof request.body === 'string' ? request.body : new Uint8Array(request.body).buffer,
          headers: { 'Content-Type': 'application/x-sentry-envelope' },
        });
        await response.arrayBuffer();
        return {
          statusCode: response.status,
          headers: {
            'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
            'retry-after': response.headers.get('retry-after'),
          },
        };
      }),
  });
  const scope = new Scope();
  scope.setClient(client);
  scope.setTag('service', 'convex');
  client.init();

  try {
    return await callback(scope);
  } finally {
    // Convex does not keep background promises alive after an action returns.
    const flushed = await client.flush(2000);
    if (!flushed) console.error('tinybird.sentry_flush_failed');
  }
}

export function fetchPipe<T>(options: FetchPipeOptions<T>): Promise<T[]> {
  return withTinybirdTracing((sentryScope) => fetchPipeCore({ ...options, sentryScope }));
}

export function runAdminSql(options: RunAdminSqlOptions): Promise<Record<string, unknown>[]> {
  return withTinybirdTracing((sentryScope) => runAdminSqlCore({ ...options, sentryScope }));
}
