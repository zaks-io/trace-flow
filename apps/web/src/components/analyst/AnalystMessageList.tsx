'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  hasAnalystMessageContent,
  normalizeAnalystMessages,
  type AnalystMessage,
  type NormalizedAnalystMessage,
} from './analystMessageModel';
import { AnalystMessagePartView, type AnalystMessagePart } from './AnalystMessagePartView';
import {
  AnalystToolTimeline,
  isTimelinePart,
  toTimelinePart,
  type TimelinePart,
} from './AnalystToolTimeline';

export type { AnalystMessage, NormalizedAnalystMessage } from './analystMessageModel';

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
  const ordered = normalizeAnalystMessages(messages);

  return (
    <div className="space-y-3">
      {canLoadMore && (
        <Button type="button" variant="outline" size="sm" onClick={loadMore} className="w-full">
          Load older
        </Button>
      )}
      {ordered.map((message, index) => (
        <div key={message.key} className="space-y-2">
          <MessageBubble message={message} />
          {shouldShowWorkingIndicator(ordered, index, busy) && <WorkingIndicator />}
        </div>
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: NormalizedAnalystMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        <MessageContent message={message} />
      </div>
    </div>
  );
}

function MessageContent({ message }: { message: NormalizedAnalystMessage }) {
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
  const groups = groupMessageParts(parts, message.key);

  return (
    <div className="space-y-2">
      {groups.map((group) =>
        Array.isArray(group) ? (
          <AnalystToolTimeline key={group[0]?.key ?? 'timeline'} parts={group} />
        ) : (
          <AnalystMessagePartView
            key={partKey(group.part, group.key)}
            part={group.part}
            isStreaming={isStreaming}
          />
        ),
      )}
      <MessageStatusLine status={message.status} hasContent={hasAnalystMessageContent(message)} />
    </div>
  );
}

type PartGroup =
  | TimelinePart[]
  | {
      key: string;
      part: AnalystMessagePart;
    };

function groupMessageParts(parts: AnalystMessagePart[], messageKey: string): PartGroup[] {
  const groups: PartGroup[] = [];
  let timeline: TimelinePart[] = [];

  const flushTimeline = () => {
    if (timeline.length > 0) {
      groups.push(timeline);
      timeline = [];
    }
  };

  parts.forEach((part, index) => {
    if (part.type === 'step-start') return;

    const key = partKey(part, `${messageKey}:${index}`);
    if (isTimelinePart(part)) {
      const timelinePart = toTimelinePart(part, key);
      if (timelinePart) timeline.push(timelinePart);
      return;
    }

    flushTimeline();
    groups.push({ key, part });
  });

  flushTimeline();
  return groups;
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
      <div className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
        Message failed
      </div>
    );
  }

  const label = status === 'pending' ? 'Waiting for stream' : 'Streaming';
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
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

function shouldShowWorkingIndicator(
  messages: NormalizedAnalystMessage[],
  index: number,
  busy: boolean,
) {
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
