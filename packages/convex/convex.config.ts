import { defineApp } from 'convex/server';
import rateLimiter from '@convex-dev/rate-limiter/convex.config.js';
import launchdarkly from '@convex-dev/launchdarkly/convex.config.js';

const app = defineApp();
app.use(rateLimiter);
app.use(launchdarkly);

export default app;
