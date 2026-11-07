/**
 * Production records one in ten new traces to stay within the shared Sentry span quota. Other
 * environments keep every trace for debugging. A continued trace keeps its parent's decision, so
 * the queue, Durable Object, and RPC legs of a recorded request stay complete. Errors and logs are
 * not sampled by this rate.
 */
const PRODUCTION_TRACES_SAMPLE_RATE = 0.1;

export function sentryTracesSampleRate(environment: string | undefined): number {
  return environment === 'prod' ? PRODUCTION_TRACES_SAMPLE_RATE : 1;
}
