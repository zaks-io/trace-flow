import type { LLMTokenUsage, LLMResponseMetadata } from '@trace-flow/types';
import type { ResolvedRoute } from '@trace-flow/llm-providers';
import type { TracingDecision } from './context';

// Analytics Engine slot layout:
// blobs:   provider, status_code, operation, skip_reason, is_sse, model
// doubles: total_latency_ms, prep_latency_ms, ttfb_ms, is_server_error,
//          total_tokens, prompt_tokens, completion_tokens, cache_read_tokens,
//          response_size, storage_status (1=stored, 0=failed, -1=skipped/omitBody),
//          upstream_ttfb_ms
// Queries must use sum(_sample_interval) for counts, quantileExactWeighted for percentiles

interface RecordedAnalyticsParams {
  analytics: AnalyticsEngineDataset;
  orgId: string;
  route: ResolvedRoute;
  responseStatus: number;
  operationName: string | undefined;
  isSSE: boolean;
  responseMetadata: Partial<LLMResponseMetadata> | undefined;
  requestStart: number;
  requestSent: number;
  responseReceived: number;
  responseComplete: number;
  firstTokenReceived: number | undefined;
  tokens: LLMTokenUsage | undefined;
  totalSize: number;
  storageSkipped: boolean;
  stored: boolean;
}

export function writeRequestAnalytics(params: RecordedAnalyticsParams): void {
  const {
    analytics,
    orgId,
    route,
    responseStatus,
    operationName,
    isSSE,
    responseMetadata,
    requestStart,
    requestSent,
    responseReceived,
    responseComplete,
    firstTokenReceived,
    tokens,
    totalSize,
    storageSkipped,
    stored,
  } = params;

  analytics.writeDataPoint({
    indexes: [orgId],
    blobs: [
      route.provider.id,
      responseStatus.toString(),
      operationName ?? '',
      '',
      isSSE ? '1' : '0',
      responseMetadata?.model ?? '',
    ],
    doubles: [
      responseComplete - requestStart,
      requestSent - requestStart,
      firstTokenReceived ? firstTokenReceived - requestSent : 0,
      responseStatus >= 500 ? 1 : 0,
      tokens?.totalTokens ?? 0,
      tokens?.promptTokens ?? 0,
      tokens?.completionTokens ?? 0,
      tokens?.cacheReadTokens ?? 0,
      totalSize,
      storageSkipped ? -1 : stored ? 1 : 0,
      responseReceived - requestSent,
    ],
  });
}

export function writeSkippedAnalytics(
  analytics: AnalyticsEngineDataset,
  orgId: string,
  route: ResolvedRoute,
  responseStatus: number,
  operationName: string | undefined,
  decision: TracingDecision,
  isSSE: boolean,
): void {
  analytics.writeDataPoint({
    indexes: [orgId],
    blobs: [
      route.provider.id,
      responseStatus.toString(),
      operationName ?? '',
      decision.reason ?? '',
      isSSE ? '1' : '0',
      '',
    ],
    doubles: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // match recording path slot count
  });
}
