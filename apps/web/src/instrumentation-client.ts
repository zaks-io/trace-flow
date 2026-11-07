import * as Sentry from '@sentry/nextjs';
import { sentryTracesSampleRate } from '@trace-flow/utils';
import { apiTracePropagationTargets } from '@/lib/trace-propagation';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const environment = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV;

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    release: process.env.NEXT_PUBLIC_DEPLOY_ID,
    sendDefaultPii: false,
    tracesSampleRate: sentryTracesSampleRate(environment),
    tracePropagationTargets: apiTracePropagationTargets(),
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    enableLogs: true,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
