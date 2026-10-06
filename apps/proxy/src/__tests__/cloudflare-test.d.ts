/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { ProxyEnv } from '../context';

declare global {
  namespace Cloudflare {
    interface Env extends ProxyEnv {
      STORAGE: ProxyEnv['STORAGE'];
    }
  }
}
