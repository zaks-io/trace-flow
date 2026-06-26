import type { UIMessage } from '@convex-dev/agent/react';

export type AnalystMessage = UIMessage;

export type NormalizedAnalystMessage = AnalystMessage & {
  key: string;
};

type AnalystMetadataCarrier = {
  metadata?: unknown;
  providerMetadata?: unknown;
};

const INTERNAL_SANDBOX_CONTINUATION_PREFIX =
  'A background Pi coding-agent analysis completed. Use this final composed response to answer the user';

export function normalizeAnalystMessages(messages: AnalystMessage[]): NormalizedAnalystMessage[] {
  const ordered = [...messages]
    .filter((message) => !isHiddenAnalystMessage(message))
    .sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order;
      return left.stepOrder - right.stepOrder;
    });

  const normalized: NormalizedAnalystMessage[] = [];
  for (const message of ordered) {
    const previous = normalized.at(-1);
    if (previous && shouldCombineAssistantMessages(previous, message)) {
      normalized[normalized.length - 1] = combineAssistantMessages(previous, message);
      continue;
    }
    normalized.push(withStableKey(message));
  }

  return normalized;
}

export function isHiddenAnalystMessage(message: AnalystMetadataCarrier): boolean {
  return (
    hasHiddenTraceFlowAnalystMetadata(message.providerMetadata) ||
    hasHiddenTraceFlowAnalystMetadata(readProviderMetadataFromMetadata(message.metadata)) ||
    isInternalSandboxContinuationMessage(message)
  );
}

export function hasAnalystMessageContent(message: AnalystMessage): boolean {
  if (message.text.trim()) return true;
  return message.parts.some((part) => {
    if (part.type === 'step-start') return false;
    if ('text' in part && typeof part.text === 'string' && part.text.trim()) return true;
    if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) return true;
    if (part.type.startsWith('data-')) return true;
    return part.type === 'source-url' || part.type === 'source-document' || part.type === 'file';
  });
}

function shouldCombineAssistantMessages(left: NormalizedAnalystMessage, right: AnalystMessage) {
  return left.role === 'assistant' && right.role === 'assistant' && left.order === right.order;
}

function combineAssistantMessages(
  left: NormalizedAnalystMessage,
  right: AnalystMessage,
): NormalizedAnalystMessage {
  const rightWithKey = withStableKey(right);
  return {
    ...left,
    id: left.id,
    key: left.key,
    _creationTime: Math.min(left._creationTime, rightWithKey._creationTime),
    stepOrder: Math.min(left.stepOrder, rightWithKey.stepOrder),
    status: combineMessageStatus(left.status, rightWithKey.status),
    text: joinText(left.text, rightWithKey.text),
    parts: [...left.parts, ...rightWithKey.parts],
  };
}

function combineMessageStatus(
  left: AnalystMessage['status'],
  right: AnalystMessage['status'],
): AnalystMessage['status'] {
  if (left === 'failed' || right === 'failed') return 'failed';
  if (left === 'streaming' || right === 'streaming') return 'streaming';
  if (left === 'pending' || right === 'pending') return 'pending';
  return right;
}

function withStableKey(message: AnalystMessage): NormalizedAnalystMessage {
  const candidate = 'key' in message && typeof message.key === 'string' ? message.key : '';
  if (candidate) return message as NormalizedAnalystMessage;
  return {
    ...message,
    key: `${message.role}:${message.order}:${message.stepOrder}:${message.id}`,
  };
}

function joinText(left: string, right: string) {
  const parts = [left.trim(), right.trim()].filter(Boolean);
  return parts.join('\n\n');
}

function hasHiddenTraceFlowAnalystMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const metadata = record.traceFlowAnalyst;
  return Boolean(
    metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>).hidden === true,
  );
}

function readProviderMetadataFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  return (metadata as { providerMetadata?: unknown }).providerMetadata;
}

function isInternalSandboxContinuationMessage(message: AnalystMetadataCarrier) {
  const candidate = message as AnalystMessage & { message?: unknown };
  const role =
    typeof candidate.role === 'string'
      ? candidate.role
      : candidate.message && typeof candidate.message === 'object'
        ? (candidate.message as { role?: unknown }).role
        : undefined;
  if (role !== 'user') return false;

  const text =
    typeof candidate.text === 'string'
      ? candidate.text
      : candidate.message && typeof candidate.message === 'object'
        ? readStringMessageContent((candidate.message as { content?: unknown }).content)
        : undefined;
  return Boolean(text?.trimStart().startsWith(INTERNAL_SANDBOX_CONTINUATION_PREFIX));
}

function readStringMessageContent(content: unknown) {
  return typeof content === 'string' ? content : undefined;
}
