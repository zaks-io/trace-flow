'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { hasAnalystMessageContent, type AnalystMessage } from './analystMessageModel';
import { AnalystMessagePartView, type AnalystMessagePart } from './AnalystMessagePartView';
import { AnalystToolStep, isTimelinePart, toTimelinePart } from './AnalystToolTimeline';

export type { AnalystMessage } from './analystMessageModel';

export function AnalystMessageList({
  messages,
  canLoadMore,
  loadMore,
  busy = false,
}: {
  messages: AnalystMessage[];
  canLoadMore: boolean;
  loadMore: () => void;
  busy?: boolean;
}) {
  return (
    <div className="space-y-3">
      {canLoadMore && (
        <Button type="button" variant="outline" size="sm" onClick={loadMore} className="w-full">
          Load older
        </Button>
      )}
      {messages.map((message, index) => (
        <div key={message.key} className="space-y-2">
          <MessageBubble message={message} />
          {shouldShowWorkingIndicator(messages, index, busy) && <WorkingIndicator />}
        </div>
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: AnalystMessage }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
          <MessageContent message={message} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start gap-2">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 max-w-[calc(100%-2rem)] flex-1 text-sm leading-relaxed text-foreground">
        <MessageContent message={message} />
      </div>
    </div>
  );
}

function MessageContent({ message }: { message: AnalystMessage }) {
  const parts: AnalystMessagePart[] = message.parts.length
    ? message.parts
    : [
        {
          type: 'text',
          text: message.text,
          state: message.status === 'streaming' ? 'streaming' : 'done',
        },
      ];
  const isStreaming = message.status === 'streaming';

  return (
    <div className="space-y-2">
      {parts.map((part, index) => (
        <PartView
          key={partKey(part, `${message.key}:${index}`)}
          part={part}
          isStreaming={isStreaming}
        />
      ))}
      <MessageStatusLine status={message.status} hasContent={hasAnalystMessageContent(message)} />
    </div>
  );
}

function PartView({ part, isStreaming }: { part: AnalystMessagePart; isStreaming: boolean }) {
  if (part.type === 'step-start') return null;

  if (isTimelinePart(part)) {
    const timelinePart = toTimelinePart(part, 'part');
    if (!timelinePart) return null;
    return <AnalystToolStep part={timelinePart} />;
  }

  return <AnalystMessagePartView part={part} isStreaming={isStreaming} />;
}

function MessageStatusLine({
  status,
  hasContent,
}: {
  status: AnalystMessage['status'];
  hasContent: boolean;
}) {
  if (status === 'success' || (status === 'pending' && hasContent)) return null;

  if (status === 'failed') {
    return (
      <div className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
        Message failed
      </div>
    );
  }

  const label = status === 'pending' ? 'Waiting for stream' : 'Streaming';
  return (
    <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      {label}
    </div>
  );
}

function WorkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Analyst is working
      </div>
    </div>
  );
}

function shouldShowWorkingIndicator(messages: AnalystMessage[], index: number, busy: boolean) {
  if (!busy || messages[index]?.role !== 'user') return false;

  const laterMessages = messages.slice(index + 1);
  const laterUser = laterMessages.some((message) => message.role === 'user');
  if (laterUser) return false;

  const visibleAssistantAfter = laterMessages.some(
    (message) => message.role === 'assistant' && hasAnalystMessageContent(message),
  );
  return !visibleAssistantAfter;
}

function partKey(part: AnalystMessagePart, fallback: string) {
  if ('toolCallId' in part && part.toolCallId) return part.toolCallId;
  if ('sourceId' in part && part.sourceId) return part.sourceId;
  if ('id' in part && part.id) return part.id;
  return `${part.type}:${fallback}`;
}
