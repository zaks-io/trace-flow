import * as Sentry from '@sentry/nextjs';
import { apiTracePropagationTargets } from '@/lib/trace-propagation';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_DEPLOY_ID,
    sendDefaultPii: false,
    tracesSampleRate: 1.0,
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
