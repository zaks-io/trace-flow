import type { Scope } from '@sentry/core';
import {
  fetchPipe as fetchPipeCore,
  runAdminSql as runAdminSqlCore,
  type FetchPipeOptions,
  type RunAdminSqlOptions,
} from '@trace-flow/tinybird-client';
import { withConvexTracing } from './convexTracing';

export async function withTinybirdTracing<T>(callback: (scope: Scope) => Promise<T>): Promise<T> {
  return withConvexTracing({ name: 'convex.tinybird' }, callback);
}

export function fetchPipe<T>(options: FetchPipeOptions<T>): Promise<T[]> {
  if (options.sentryScope) return fetchPipeCore(options);
  return withTinybirdTracing((sentryScope) => fetchPipeCore({ ...options, sentryScope }));
}

export function runAdminSql(options: RunAdminSqlOptions): Promise<Record<string, unknown>[]> {
  if (options.sentryScope) return runAdminSqlCore(options);
  return withTinybirdTracing((sentryScope) => runAdminSqlCore({ ...options, sentryScope }));
}
