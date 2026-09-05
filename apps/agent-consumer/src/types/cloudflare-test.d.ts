/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { AgentConsumerEnv } from '../context';

declare global {
  namespace Cloudflare {
    interface Env {
      AGENT_QUEUE: AgentConsumerEnv['AGENT_QUEUE'];
      MODEL_PRICING: AgentConsumerEnv['MODEL_PRICING'];
      AGENT_FACT_BATCHER: AgentConsumerEnv['AGENT_FACT_BATCHER'];
      TINYBIRD_TOKEN: AgentConsumerEnv['TINYBIRD_TOKEN'];
      TINYBIRD_HOST: AgentConsumerEnv['TINYBIRD_HOST'];
      TINYBIRD_AGENT_WRITE_MODE?: AgentConsumerEnv['TINYBIRD_AGENT_WRITE_MODE'];
      SENTRY_DSN?: AgentConsumerEnv['SENTRY_DSN'];
      SENTRY_ENVIRONMENT?: AgentConsumerEnv['SENTRY_ENVIRONMENT'];
      CF_VERSION_METADATA?: AgentConsumerEnv['CF_VERSION_METADATA'];
      AXIOM_TOKEN?: AgentConsumerEnv['AXIOM_TOKEN'];
      AXIOM_DATASET?: AgentConsumerEnv['AXIOM_DATASET'];
      AXIOM_DOMAIN?: AgentConsumerEnv['AXIOM_DOMAIN'];
    }
  }
}
