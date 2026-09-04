/// <reference types="vite/client" />
import { convexTest, type TestConvex } from 'convex-test';
import type { GenericSchema, SchemaDefinition } from 'convex/server';
import schema from '../schema';
import agent from '@convex-dev/agent/test';
import rateLimiter from '@convex-dev/rate-limiter/test';
import launchdarkly from '@convex-dev/launchdarkly/test';

const modules = import.meta.glob(['../**/*.*s', '!../__tests__/**']);

export type ArchiveTestConvex = ReturnType<typeof initConvexTest>;

export function initConvexTest() {
  const t = convexTest(schema, modules);
  agent.register(t);
  const generic = t as unknown as TestConvex<SchemaDefinition<GenericSchema, boolean>>;
  rateLimiter.register(generic);
  launchdarkly.register(generic);
  return t;
}
