import type { UIMessage } from '@convex-dev/agent/react';

export type AnalystMessage = UIMessage;

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
