/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as WorkerEnv } from '../index';

declare global {
  namespace Cloudflare {
    interface Env {
      STORAGE: WorkerEnv['STORAGE'];
      TINYBIRD_TOKEN: WorkerEnv['TINYBIRD_TOKEN'];
      TINYBIRD_DATASOURCE?: WorkerEnv['TINYBIRD_DATASOURCE'];
      TINYBIRD_LEGACY_DATASOURCE?: WorkerEnv['TINYBIRD_LEGACY_DATASOURCE'];
      TINYBIRD_TRACE_WRITE_MODE?: WorkerEnv['TINYBIRD_TRACE_WRITE_MODE'];
      TINYBIRD_HOST?: WorkerEnv['TINYBIRD_HOST'];
      TRACE_BATCHER: WorkerEnv['TRACE_BATCHER'];
      NUM_SHARDS?: WorkerEnv['NUM_SHARDS'];
      MODEL_PRICING: WorkerEnv['MODEL_PRICING'];
      ANALYTICS: WorkerEnv['ANALYTICS'];
      AXIOM_TOKEN?: WorkerEnv['AXIOM_TOKEN'];
      AXIOM_DATASET?: WorkerEnv['AXIOM_DATASET'];
      AXIOM_DOMAIN?: WorkerEnv['AXIOM_DOMAIN'];
      SENTRY_DSN?: WorkerEnv['SENTRY_DSN'];
      SENTRY_ENVIRONMENT?: WorkerEnv['SENTRY_ENVIRONMENT'];
      CF_VERSION_METADATA?: WorkerEnv['CF_VERSION_METADATA'];
    }
  }
}
