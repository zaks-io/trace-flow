import type { LLMTiming, LLMTokenUsage } from '@trace-flow/types';
import { GEN_AI, TRACE_FLOW } from '../keys';

/**
 * Timing attributes on the Root Span. Always emits proxy overhead and upstream
 * TTFB. Tokens-per-second is emitted when output tokens exist; the calculation
 * uses generation duration (first-token → complete) and falls back to full
 * request latency for single-chunk responses (thinking models that emit a
 * complete payload in one tick — `firstTokenReceived` ≈ `responseComplete`).
 */
export function timingAttributes(
  timing: LLMTiming,
  tokens?: LLMTokenUsage,
): Record<string, string> {
  const proxyOverheadMs = timing.requestSent - timing.requestStart;
  const upstreamTtfbMs = timing.responseReceived - timing.requestSent;

  const out: Record<string, string> = {
    [TRACE_FLOW.PROXY_OVERHEAD_MS]: String(proxyOverheadMs),
    [TRACE_FLOW.UPSTREAM_TTFB_MS]: String(upstreamTtfbMs),
  };

  if (tokens?.completionTokens && tokens.completionTokens > 0) {
    const generationStartMs = timing.firstTokenReceived ?? timing.requestSent;
    let generationDurationMs = timing.responseComplete - generationStartMs;
    if (generationDurationMs <= 0) {
      generationDurationMs = timing.responseComplete - timing.requestSent;
    }
    if (generationDurationMs > 0) {
      const tps = tokens.completionTokens / (generationDurationMs / 1000);
      out[GEN_AI.TOKENS_PER_SECOND] = tps.toFixed(2);
    }
  }

  return out;
}

/**
 * Server-side time-to-first-token. Used both as a Root Span attribute and as
 * the payload of the `output.time_to_first_token` event, so the same key flows
 * through both consumers.
 */
export function ttftAttributes(ttftMs: number): Record<string, string> {
  return { [GEN_AI.SERVER_TTFT]: String(ttftMs) };
}
