import { defineApp } from 'convex/server';
import rateLimiter from '@convex-dev/rate-limiter/convex.config.js';
import launchdarkly from '@convex-dev/launchdarkly/convex.config.js';
import agent from '@convex-dev/agent/convex.config';

const app = defineApp();
app.use(rateLimiter);
app.use(launchdarkly);
app.use(agent);

export default app;
