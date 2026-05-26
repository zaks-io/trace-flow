import type { QueueMessage, TinybirdTrace, AnthropicContentBlock } from '@trace-flow/types';
import { RETENTION_DAYS } from '@trace-flow/types';
import { generateSpanId } from '@trace-flow/utils';
import {
  createSpan,
  GEN_AI,
  SPAN_KIND,
  SPAN_NAMES,
  STATUS_CODE,
  EVENT_NAMES,
  requestAttributes,
  tokenAttributes,
  costAttributes,
  upstreamCostAttribute,
  responseMetadataAttributes,
  errorAttributes,
  timingAttributes,
  ttftAttributes,
  baggageAttributes,
  inputMessageEvents,
  outputBlockEvents,
  toolCallBracketEvents,
  contentBlockSpanAttributes,
  outputEventName,
  type SpanBase,
  type SpanEventInput,
} from '@trace-flow/otel-conventions';
import { type ModelPricing, calculateCost } from '@trace-flow/pricing';

const NANOSECONDS_PER_DAY = 24 * 60 * 60 * 1_000_000_000;
const SERVICE_NAME = 'llm-observability';

interface SharedState {
  base: SpanBase;
  model: string;
  operationName: string;
  isStreaming: boolean;
}

interface SSEWalk {
  ttftMs?: number;
  ttftTimestampMs?: number;
  allContentBlocks: { block: AnthropicContentBlock; messageIndex: number }[];
}

/**
 * Retention enforcement: a Span's `RetentionExpiresAt` is stamped at write-time
 * from the Organization's Subscription Tier (`hobby`: 7d, `pro`: 30d). The Tier
 * at ingestion is also persisted so a future upgrade can widen visibility for
 * already-stored Spans without rewriting their `RetentionExpiresAt`.
 */
function calculateRetentionExpiresAt(receivedAt: number, tier?: string): number {
  const retentionDays = tier === 'pro' ? RETENTION_DAYS.pro : RETENTION_DAYS.hobby;
  return receivedAt + retentionDays * NANOSECONDS_PER_DAY;
}

function getNonStreamingOutputType(operationName: string): string {
  return operationName === 'embeddings' ? 'embedding' : 'text';
}

function deriveSharedState(data: QueueMessage): SharedState {
  const traceId = data.traceId ?? data.requestId;
  const tierAtIngestion = data.tier ?? 'hobby';
  const retentionExpiresAt = calculateRetentionExpiresAt(data.receivedAt, data.tier);
  const isStreaming = Boolean(
    data.sseStreamData?.messages && data.sseStreamData.messages.length > 0,
  );
  const operationName = data.operationName ?? 'chat';
  const model =
    data.responseMetadata?.model ?? (data.request.model !== 'unknown' ? data.request.model : '');

  return {
    base: {
      traceId,
      receivedAt: data.receivedAt,
      apiKey: data.apiKey,
      tierAtIngestion,
      retentionExpiresAt,
      serviceName: SERVICE_NAME,
    },
    model,
    operationName,
    isStreaming,
  };
}

function walkSSEStream(data: QueueMessage): SSEWalk {
  const sseMessages = data.sseStreamData?.messages ?? [];
  const allContentBlocks: { block: AnthropicContentBlock; messageIndex: number }[] = [];

  let ttftMs: number | undefined;
  let ttftTimestampMs: number | undefined;
  for (const message of sseMessages) {
    const delta = message.events.find(
      (e) => e.type === 'content_block_delta' || e.type === 'response.output_text.delta',
    );
    if (delta) {
      ttftTimestampMs = delta.timestamp;
      ttftMs = delta.timestamp - data.timing.requestStart;
      break;
    }
  }

  const traceId = data.traceId ?? data.requestId;
  for (const [messageIndex, message] of sseMessages.entries()) {
    if (!message.messageStop) {
      console.warn('Incomplete message detected (no messageStop):', { messageIndex, traceId });
      continue;
    }
    if (message.contentBlocks) {
      for (const block of message.contentBlocks) {
        allContentBlocks.push({ block, messageIndex });
      }
    }
  }

  return { ttftMs, ttftTimestampMs, allContentBlocks };
}

function buildNonStreamingOutputEvent(data: QueueMessage, operationName: string): SpanEventInput {
  const outputType = getNonStreamingOutputType(operationName);
  return {
    timestampMs: data.timing.responseComplete,
    name: outputEventName(outputType),
    attributes: {
      [GEN_AI.CONTENT_TYPE]: outputType,
      [GEN_AI.RESPONSE_STREAMING]: 'false',
    },
  };
}

function buildRoot(
  data: QueueMessage,
  shared: SharedState,
  sseWalk: SSEWalk,
  pricing: ModelPricing | null | undefined,
  rootSpanId: string,
): TinybirdTrace {
  const { isStreaming, operationName, model, base } = shared;

  const attributes: Record<string, string> = {
    ...requestAttributes(data, { isStreaming, operationName }),
    ...timingAttributes(data.timing, data.tokens),
    ...(data.baggage ? baggageAttributes(data.baggage) : {}),
  };

  if (data.tokens) {
    Object.assign(attributes, tokenAttributes(data.tokens));
    if (pricing) {
      Object.assign(attributes, costAttributes(calculateCost(data.tokens, pricing)));
    }
    Object.assign(attributes, upstreamCostAttribute(data.tokens.upstreamCost));
  }

  if (data.responseMetadata) {
    Object.assign(attributes, responseMetadataAttributes(data.responseMetadata));
  }
  if (data.error) {
    Object.assign(attributes, errorAttributes(data.error));
  }
  if (sseWalk.ttftMs !== undefined) {
    Object.assign(attributes, ttftAttributes(sseWalk.ttftMs));
  }

  const events: SpanEventInput[] = [];

  if (sseWalk.ttftMs !== undefined && sseWalk.ttftTimestampMs !== undefined) {
    events.push({
      timestampMs: sseWalk.ttftTimestampMs,
      name: EVENT_NAMES.OUTPUT_TIME_TO_FIRST_TOKEN,
      attributes: ttftAttributes(sseWalk.ttftMs),
    });
  }
  if (data.inputMessages && data.inputMessages.length > 0) {
    events.push(...inputMessageEvents(data.inputMessages, data.timing.requestStart));
  }
  if (isStreaming) {
    if (sseWalk.allContentBlocks.length > 0) {
      events.push(
        ...outputBlockEvents(
          sseWalk.allContentBlocks.map(({ block }) => block),
          data.timing.responseComplete,
        ),
      );
    } else {
      events.push(buildNonStreamingOutputEvent(data, operationName));
    }
  } else if (data.response.status < 400) {
    events.push(buildNonStreamingOutputEvent(data, operationName));
  }

  return createSpan(base, {
    spanId: rootSpanId,
    spanName: SPAN_NAMES.rootFor(operationName, model),
    spanKind: SPAN_KIND.CLIENT,
    parentSpanId: data.parentSpanId ?? '',
    traceState: data.traceState ?? '',
    timestampMs: data.timing.requestStart,
    durationMs: data.timing.responseComplete - data.timing.requestStart,
    attributes,
    events,
    statusCode: data.error ? STATUS_CODE.ERROR : STATUS_CODE.OK,
    statusMessage: data.error?.message ?? '',
  });
}

function buildResponse(data: QueueMessage, shared: SharedState, rootSpanId: string): TinybirdTrace {
  const outputType = getNonStreamingOutputType(shared.operationName);
  return createSpan(shared.base, {
    spanName: SPAN_NAMES.responseFor(outputType),
    spanKind: SPAN_KIND.INTERNAL,
    parentSpanId: rootSpanId,
    timestampMs: data.timing.requestSent,
    durationMs: data.timing.responseComplete - data.timing.requestSent,
    attributes: {
      [GEN_AI.REQUEST_ID]: data.requestId,
      [GEN_AI.RESPONSE_STREAMING]: 'false',
      [GEN_AI.CONTENT_TYPE]: outputType,
      [GEN_AI.MESSAGE_INDEX]: String(data.inputMessages?.length ?? 0),
    },
  });
}

function buildContentBlocks(
  data: QueueMessage,
  shared: SharedState,
  rootSpanId: string,
  sseWalk: SSEWalk,
): TinybirdTrace[] {
  const inputMessageCount = data.inputMessages?.length ?? 0;
  const contentBlocks = sseWalk.allContentBlocks;

  const typeCounts: Record<string, number> = {};
  for (const { block } of contentBlocks) {
    if (block.stopTimestamp) typeCounts[block.type] = (typeCounts[block.type] ?? 0) + 1;
  }

  const typeOccurrences: Record<string, number> = {};
  const spans: TinybirdTrace[] = [];

  for (const { block, messageIndex } of contentBlocks) {
    if (!block.stopTimestamp) continue;

    typeOccurrences[block.type] = (typeOccurrences[block.type] ?? 0) + 1;
    const occurrenceNum = typeOccurrences[block.type];
    const totalOfType = typeCounts[block.type] ?? 1;

    spans.push(
      createSpan(shared.base, {
        spanName: SPAN_NAMES.responseFor(block.type, totalOfType > 1 ? occurrenceNum : undefined),
        spanKind: SPAN_KIND.INTERNAL,
        parentSpanId: rootSpanId,
        timestampMs: block.startTimestamp,
        durationMs: block.stopTimestamp - block.startTimestamp,
        attributes: contentBlockSpanAttributes(
          block,
          messageIndex,
          data.requestId,
          inputMessageCount,
        ),
        events: toolCallBracketEvents(block),
      }),
    );
  }

  return spans;
}

function buildToolExecutions(
  data: QueueMessage,
  shared: SharedState,
  rootSpanId: string,
): TinybirdTrace[] {
  const toolExecutions = data.toolExecutions;
  if (!toolExecutions || toolExecutions.length === 0) return [];

  return toolExecutions.map((execution) =>
    createSpan(shared.base, {
      spanName: SPAN_NAMES.TOOL_EXECUTION,
      spanKind: SPAN_KIND.INTERNAL,
      parentSpanId: rootSpanId,
      timestampMs: execution.startTimestamp,
      durationMs: execution.endTimestamp - execution.startTimestamp,
      attributes: {
        [GEN_AI.REQUEST_ID]: data.requestId,
        [GEN_AI.TOOL_ID]: execution.toolUseId,
        [GEN_AI.TOOL_NAME]: execution.toolName,
        [GEN_AI.ORIGINAL_TRACE_ID]: execution.originalTraceId,
      },
      linkedTraceIds: [execution.originalTraceId],
    }),
  );
}

// Single seam for Span Variant selection. Keeping the decision tree here
// stops streaming and non-streaming ingest from drifting on which Spans emit.
export function buildSpans(data: QueueMessage, pricing?: ModelPricing | null): TinybirdTrace[] {
  const shared = deriveSharedState(data);
  const sseWalk: SSEWalk = shared.isStreaming ? walkSSEStream(data) : { allContentBlocks: [] };

  const rootSpanId = generateSpanId();
  const traces: TinybirdTrace[] = [buildRoot(data, shared, sseWalk, pricing, rootSpanId)];

  if (shared.isStreaming && sseWalk.allContentBlocks.length > 0) {
    traces.push(...buildContentBlocks(data, shared, rootSpanId, sseWalk));
  } else if (!shared.isStreaming && data.response.status < 400) {
    traces.push(buildResponse(data, shared, rootSpanId));
  }

  traces.push(...buildToolExecutions(data, shared, rootSpanId));

  return traces;
}
