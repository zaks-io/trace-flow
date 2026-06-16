import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_DEPLOY_ID,
    sendDefaultPii: false,
    tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
    tracePropagationTargets: [/^\//, /trace-flow\.dev/],
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
