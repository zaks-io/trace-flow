/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { AgentConsumerEnv } from '../context';

declare global {
  namespace Cloudflare {
    interface Env extends AgentConsumerEnv {
      AGENT_DEAD_LETTERS: AgentConsumerEnv['AGENT_DEAD_LETTERS'];
    }
  }
}
