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
import { type ModelPricing, calculateCost } from './pricing';

const NANOSECONDS_PER_DAY = 24 * 60 * 60 * 1_000_000_000;
const SERVICE_NAME = 'llm-observability';

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

/**
 * Transform a Queue Message into the Span Variants it emits per OTel GenAI
 * conventions: Root Span (one) + zero or more child Spans (Response, Content
 * Block, Tool Execution). Attribute and span-name vocabularies live in
 * `@trace-flow/otel-conventions`; this function decides which variants to emit
 * and composes the per-concern helpers into each Span's attributes.
 */
export function buildTraces(data: QueueMessage, pricing?: ModelPricing | null): TinybirdTrace[] {
  const traceId = data.traceId ?? data.requestId;
  const tierAtIngestion = data.tier ?? 'hobby';
  const retentionExpiresAt = calculateRetentionExpiresAt(data.receivedAt, data.tier);
  const isStreaming = Boolean(
    data.sseStreamData?.messages && data.sseStreamData.messages.length > 0,
  );
  const operationName = data.operationName ?? 'chat';
  const model =
    data.responseMetadata?.model ?? (data.request.model !== 'unknown' ? data.request.model : '');

  const base: SpanBase = {
    traceId,
    receivedAt: data.receivedAt,
    apiKey: data.apiKey,
    tierAtIngestion,
    retentionExpiresAt,
    serviceName: SERVICE_NAME,
  };

  const rootSpanId = generateSpanId();
  const rootAttributes: Record<string, string> = {
    ...requestAttributes(data, { isStreaming, operationName }),
    ...timingAttributes(data.timing, data.tokens),
    ...(data.baggage ? baggageAttributes(data.baggage) : {}),
  };

  if (data.tokens) {
    Object.assign(rootAttributes, tokenAttributes(data.tokens));
    if (pricing) {
      Object.assign(rootAttributes, costAttributes(calculateCost(data.tokens, pricing)));
    }
    Object.assign(rootAttributes, upstreamCostAttribute(data.tokens.upstreamCost));
  }

  if (data.responseMetadata) {
    Object.assign(rootAttributes, responseMetadataAttributes(data.responseMetadata));
  }
  if (data.error) {
    Object.assign(rootAttributes, errorAttributes(data.error));
  }

  const rootEvents: SpanEventInput[] = [];
  const traces: TinybirdTrace[] = [];

  // Streaming path: TTFT detection + Content Block Spans
  const sseMessages = data.sseStreamData?.messages ?? [];
  const allContentBlocks: { block: AnthropicContentBlock; messageIndex: number }[] = [];

  if (isStreaming) {
    let firstContentDelta: { timestamp: number } | undefined;
    for (const message of sseMessages) {
      const delta = message.events.find(
        (e) => e.type === 'content_block_delta' || e.type === 'response.output_text.delta',
      );
      if (delta) {
        firstContentDelta = delta;
        break;
      }
    }
    if (firstContentDelta) {
      const ttftMs = firstContentDelta.timestamp - data.timing.requestStart;
      Object.assign(rootAttributes, ttftAttributes(ttftMs));
      rootEvents.push({
        timestampMs: firstContentDelta.timestamp,
        name: EVENT_NAMES.OUTPUT_TIME_TO_FIRST_TOKEN,
        attributes: ttftAttributes(ttftMs),
      });
    }

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
  }

  if (data.inputMessages && data.inputMessages.length > 0) {
    rootEvents.push(...inputMessageEvents(data.inputMessages, data.timing.requestStart));
  }

  if (isStreaming) {
    if (allContentBlocks.length > 0) {
      rootEvents.push(
        ...outputBlockEvents(
          allContentBlocks.map(({ block }) => block),
          data.timing.responseComplete,
        ),
      );
    } else {
      rootEvents.push(buildNonStreamingOutputEvent(data, operationName));
    }
  } else if (data.response.status < 400) {
    rootEvents.push(buildNonStreamingOutputEvent(data, operationName));
  }

  const rootSpan = createSpan(base, {
    spanId: rootSpanId,
    spanName: SPAN_NAMES.rootFor(operationName, model),
    spanKind: SPAN_KIND.CLIENT,
    parentSpanId: data.parentSpanId ?? '',
    traceState: data.traceState ?? '',
    timestampMs: data.timing.requestStart,
    durationMs: data.timing.responseComplete - data.timing.requestStart,
    attributes: rootAttributes,
    events: rootEvents,
    statusCode: data.error ? STATUS_CODE.ERROR : STATUS_CODE.OK,
    statusMessage: data.error?.message ?? '',
  });
  traces.push(rootSpan);

  if (isStreaming && allContentBlocks.length > 0) {
    const inputMessageCount = data.inputMessages?.length ?? 0;
    traces.push(
      ...buildContentBlockSpans(allContentBlocks, data, base, rootSpanId, inputMessageCount),
    );
  } else if (!isStreaming && data.response.status < 400) {
    traces.push(buildResponseSpan(data, base, rootSpanId, operationName));
  }

  if (data.toolExecutions && data.toolExecutions.length > 0) {
    traces.push(...buildToolExecutionSpans(data.toolExecutions, data, base, rootSpanId));
  }

  return traces;
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

function buildResponseSpan(
  data: QueueMessage,
  base: SpanBase,
  parentSpanId: string,
  operationName: string,
): TinybirdTrace {
  const outputType = getNonStreamingOutputType(operationName);
  return createSpan(base, {
    spanName: SPAN_NAMES.responseFor(outputType),
    spanKind: SPAN_KIND.INTERNAL,
    parentSpanId,
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

function buildContentBlockSpans(
  contentBlocks: { block: AnthropicContentBlock; messageIndex: number }[],
  data: QueueMessage,
  base: SpanBase,
  parentSpanId: string,
  inputMessageCount: number,
): TinybirdTrace[] {
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
      createSpan(base, {
        spanName: SPAN_NAMES.responseFor(block.type, totalOfType > 1 ? occurrenceNum : undefined),
        spanKind: SPAN_KIND.INTERNAL,
        parentSpanId,
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

function buildToolExecutionSpans(
  toolExecutions: NonNullable<QueueMessage['toolExecutions']>,
  data: QueueMessage,
  base: SpanBase,
  parentSpanId: string,
): TinybirdTrace[] {
  return toolExecutions.map((execution) =>
    createSpan(base, {
      spanName: SPAN_NAMES.TOOL_EXECUTION,
      spanKind: SPAN_KIND.INTERNAL,
      parentSpanId,
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
