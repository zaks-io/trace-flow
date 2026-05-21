import type { SSEStreamData } from '@trace-flow/types';
import type { EventSourceParser } from 'eventsource-parser';
import { createResponseCapture } from '../streaming/capture';
import { createSSEParser } from '../streaming/sse';
import type { ForwardedExchange } from './forwardToUpstream';

/**
 * Output of the attach stage. Composes the forwarded exchange so callers can
 * walk back to the validated request via `attached.forwarded.validated`.
 */
export interface AttachedCapture {
  forwarded: ForwardedExchange;
  isSSE: boolean;
  sseStreamData: SSEStreamData;
  parser: EventSourceParser | null;
  capture: ReturnType<typeof createResponseCapture>;
  readable: ReadableStream;
  pipePromise: Promise<void> | undefined;
}

/**
 * Wire a TransformStream between the upstream response and the client so we
 * can tee response chunks into the SSE parser without blocking the byte path.
 *
 * `pipePromise` is intentionally not awaited here — the response goes back to
 * the client immediately, and capture runs inside `waitUntil` after the
 * response stream finishes draining.
 */
export function attachCapture(forwarded: ForwardedExchange): AttachedCapture {
  const { response } = forwarded;
  const provider = forwarded.validated.route.provider;

  const isSSE = response.headers.get('Content-Type')?.includes('text/event-stream') ?? false;

  const sseStreamData: SSEStreamData = { messages: [] };
  const parser = isSSE ? createSSEParser(sseStreamData, provider) : null;

  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

  const capture = createResponseCapture((chunk) => {
    if (isSSE && parser) {
      const text = decoder.decode(chunk, { stream: true });
      parser.feed(text);
    }
  });

  const { readable, writable } = capture.transform;
  const pipePromise = response.body?.pipeTo(writable);

  return { forwarded, isSSE, sseStreamData, parser, capture, readable, pipePromise };
}
