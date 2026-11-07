import * as Sentry from '@sentry/nextjs';
import { sentryTracesSampleRate } from '@trace-flow/utils';
import { apiTracePropagationTargets } from '@/lib/trace-propagation';

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
const environment =
  process.env.SENTRY_ENVIRONMENT ??
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
  process.env.NODE_ENV;

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    release: process.env.NEXT_PUBLIC_DEPLOY_ID,
    sendDefaultPii: false,
    tracesSampleRate: sentryTracesSampleRate(environment),
    tracePropagationTargets: apiTracePropagationTargets(),
    enableLogs: true,
  });
}
