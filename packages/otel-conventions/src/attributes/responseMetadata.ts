import type { LLMResponseMetadata, LLMResponseMetadataSummary } from '@trace-flow/types';
import { GEN_AI } from '../keys';

/**
 * Provider response-metadata attributes on the Root Span. All fields are
 * conditional — only emit when the upstream actually reported them.
 *
 * `refusal` and `reasoning` are mapped to boolean presence flags
 * (`has_refusal`, `has_reasoning`) rather than carrying the raw payload, which
 * lives in the Body Object instead. Same pattern as the pre-refactor logic.
 */
export function responseMetadataAttributes(
  meta: LLMResponseMetadataSummary | Partial<LLMResponseMetadata>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (meta.id) out[GEN_AI.RESPONSE_ID] = meta.id;
  if (meta.model) out[GEN_AI.RESPONSE_MODEL] = meta.model;
  if (meta.object) out[GEN_AI.RESPONSE_OBJECT] = meta.object;
  if (meta.created !== undefined) out[GEN_AI.RESPONSE_CREATED] = String(meta.created);
  if (meta.finishReason) out[GEN_AI.FINISH_REASON] = meta.finishReason;
  if (meta.nativeFinishReason) out[GEN_AI.NATIVE_FINISH_REASON] = meta.nativeFinishReason;
  if (meta.stopReason) out[GEN_AI.STOP_REASON] = meta.stopReason;
  if (meta.stopSequence) out[GEN_AI.STOP_SEQUENCE] = meta.stopSequence;
  if (meta.hasLogprobs !== undefined) out[GEN_AI.HAS_LOGPROBS] = String(meta.hasLogprobs);
  if (meta.reasoningTokens !== undefined) {
    out[GEN_AI.REASONING_TOKENS] = String(meta.reasoningTokens);
  }
  const summary = meta as LLMResponseMetadataSummary;
  const legacy = meta as Partial<LLMResponseMetadata>;
  if (summary.hasRefusal !== undefined) {
    out[GEN_AI.HAS_REFUSAL] = String(summary.hasRefusal);
  } else if (legacy.refusal !== undefined) {
    out[GEN_AI.HAS_REFUSAL] = String(legacy.refusal !== null);
  }
  if (summary.hasReasoning !== undefined) {
    out[GEN_AI.HAS_REASONING] = String(summary.hasReasoning);
  } else if (legacy.reasoning !== undefined) {
    out[GEN_AI.HAS_REASONING] = String(legacy.reasoning !== null);
  }
  return out;
}
