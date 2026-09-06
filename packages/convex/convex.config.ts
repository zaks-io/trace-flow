import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import rateLimiter from '@convex-dev/rate-limiter/convex.config.js';
import splitch from '@splitch/convex/convex.config.js';
import agent from '@convex-dev/agent/convex.config';

const app = defineApp({ env: { SPLITCH_API_KEY: v.string() } });
app.use(rateLimiter);
app.use(splitch, {
  httpPrefix: '/integrations/splitch/',
  env: { SPLITCH_API_KEY: app.env.SPLITCH_API_KEY },
});
app.use(agent);

export default app;
