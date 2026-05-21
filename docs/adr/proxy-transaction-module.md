# Proxy Transaction Module + Composed Pipeline Stages

## Decision

Two coupled refactors on the proxy worker:

1. **Pipeline stages compose by inclusion.** Each handler stage returns a refined record (`ValidatedRequest` → `ForwardedExchange` → `AttachedCapture`) that nests the prior stage instead of merging with it. `CaptureContext` (the 30-field wide record threaded through every stage) is deleted.
2. **The captured exchange is a first-class module.** Post-response, the captured exchange drains into a `DrainedCapture`, gets built into a `Transaction` (matching the term defined in `CONTEXT.md`), then is persisted by `persistTransaction`. The 200-line `captureAndEnqueue` is replaced by three small functions plus a single composing entry point.

## Context

The proxy's post-response path looked like this:

```typescript
// apps/proxy/src/index.ts
const validated = (await validateRequest(c)).validated;
const forwarded = await forwardToUpstream(c, validated);
const attached = attachCapture(forwarded.response, validated.route.provider);

const ctx: CaptureContext = { env: c.env, ...validated, ...forwarded, ...attached };

c.executionCtx.waitUntil(ctx.decision.record ? captureAndEnqueue(ctx) : cleanupSkippedCapture(ctx));
return respond(ctx);
```

Two problems:

**`CaptureContext` was a 30-field wide record.** Every stage took the same shape and the type system tracked "what's been filled in" by spread-merge convention. JSDoc admitted it directly: _"One record, not a chain of refined subtypes — every stage takes/returns the same shape and the type system tracks 'what's been filled in' by convention rather than nominal narrowing."_ Downstream stages had no nominal way to assert "the response field is populated by now." Refactoring a single stage required scanning the whole context for which fields it actually touched.

**`captureAndEnqueue` was a 200-line procedure** that interleaved five concerns: stream draining (await pipePromise, flush SSE parser, fixup messageStop, gather captured chunks), extraction (tokens, metadata, error, input messages), redaction, persistence (R2 + queue), and analytics. `CONTEXT.md` already named this artifact "Transaction" — "the combined captured artifact for one LLM Request + LLM Response, the unit the platform produces and the unit of metering" — but no module owned it. Each new concern (truncation flag, retention stamp, encryption key) widened the procedure rather than landing in a named module.

## Why Compose Instead of Extend

Three options for the stage types:

1. **Extend (the wide-record status quo)**: every stage takes/returns a superset record. Cheap to spread; nothing nominally enforced.
2. **Inherit (intersection)**: `type AttachedCapture = ForwardedExchange & { isSSE; ... }`. Flat field access (`ctx.response`, `ctx.isSSE`), but stages lose the ability to talk about "just my stage's output" without recomputing the diff.
3. **Compose (nesting)**: `interface AttachedCapture { forwarded: ForwardedExchange; isSSE; ... }`. Slightly longer accessors (`attached.forwarded.response`), but the provenance is literal: `attached.forwarded.validated.keyData.orgId` traces back to where `orgId` was first set.

We picked **compose**. The proxy pipeline is short (four stages) and each stage's output is a coherent record callers may want to pass around independently (e.g. `recordSkippedExchange` only needs `AttachedCapture` — it doesn't need the drained body). With intersection, a function asking for "just the validated bit" would need a structural Pick. With composition, the seam is in the shape, not in a type expression.

The slightly longer accessor is a feature: it shows _which stage owns this field_. `attached.forwarded.response` vs `attached.readable` makes the difference between "upstream's response object" and "the teed body for the client" obvious at the call site.

## The Transaction Module

`CONTEXT.md` defines Transaction as:

> The combined captured artifact for one LLM Request + LLM Response. The unit the platform produces and the unit of metering.

This is a noun the platform already has — it just wasn't a type. The refactor introduces one:

```typescript
interface Transaction {
  requestId: string;
  traceId: string;
  parentSpanId?: string;
  // ... identifiers + timing + tokens + metadata + request/response bodies + sseStreamData
}
```

Notably, Transaction does **not** include `decision` or `tier`. Those are policy concerns. A Transaction is what was captured; whether it gets persisted, and under what retention, is a separate axis. The policy stamp varies independently of the captured artifact: `decision.record` can flip between attempts on the same Transaction shape (suspended account, exceeded quota, internal error), and `tier` can be unknown at build time when subscription lookup fails. Passing them alongside means `buildTransaction` stays pure, and `persistTransaction` is the only place that needs to know the policy.

Three functions split the old procedure (all in `apps/proxy/src/transaction.ts`):

- **`drainCapture(attached)`** — awaits the pipePromise, flushes the SSE parser, fixes up messageStop on Google streams, snapshots `firstTokenReceived` / `isTruncated` / `totalSize`, and returns request + response strings. Pure stream-side work; no extraction, no IO.
- **`buildTransaction(drained, logger)`** — the pure extraction step: tokens (streaming-vs-whole-body branch), input messages, error parsing, response metadata (via `provider.parseResponseMetadata(body, { targetUrl })`). No redaction, no R2, no queue.
- **`persistTransaction(env, transaction, { tier, route, omitBody, logger })`** — redacts, writes the Body Object, builds and sends the Queue Message, records analytics. Each side effect is wrapped in its own try/catch so a queue failure can be distinguished from an R2 or analytics failure in logs. Bundled because they all consume the same redacted shape and write to org-scoped destinations together.

The skip path stays separate: `recordSkippedExchange(env, attached, { decision, route, logger })` cancels the capture stream and writes skip analytics without producing a Transaction.

### Why `persistTransaction` Bundles Analytics

R2 storage, queue dispatch, and Analytics Engine writes all happen in `waitUntil` and all read the same redacted shape. Separating them into `storeTransaction`, `enqueueTransaction`, `recordTransactionAnalytics` would force the caller to thread the redacted shape three times and decide ordering. The bundled function lets the caller hand off the Transaction and forget about it — the unit-of-metering treatment matches the unit's name.

## Provider Interface Change

Removing `CaptureContext` exposed a second shallow seam: `Provider.resolveModelFromUrl?`. This optional method existed only because Google's embed responses don't carry `modelVersion` in the body, so the proxy fell back to parsing the URL path. The fallback lived in `captureAndEnqueue`:

```typescript
if (!responseMetadata?.model && provider.resolveModelFromUrl) {
  const pathModel = provider.resolveModelFromUrl(targetUrl);
  if (pathModel) responseMetadata = { ...(responseMetadata ?? {}), model: pathModel };
}
```

That's the proxy knowing a per-provider quirk. The fix is to push it into the Provider:

```typescript
parseResponseMetadata(body: string, ctx?: { targetUrl: string }): Partial<LLMResponseMetadata> | undefined;
```

Google's adapter merges its URL-path fallback into `parseResponseMetadata`; every other Provider ignores the optional `ctx`. `resolveModelFromUrl` is removed from the interface entirely.

## Trade-offs

### Nested accessor paths

`attached.forwarded.validated.keyData.orgId` is more characters than `ctx.orgId`. The proxy pipeline is short (four stages, max nesting depth of three) so it stays readable, but adding a fifth stage would push toward six-character chain accesses at call sites. If the pipeline grows further, the alternative is to either destructure at the function head or revisit composition vs intersection.

### Refactoring a stage type changes downstream call paths

Renaming a field on `ForwardedExchange` ripples into every `.forwarded.<field>` access in `AttachedCapture` consumers. With intersection, the same rename would be a single-step refactor at the consumer. The trade is paid for nominal clarity about which stage owns each field.

### Bundled persistence couples three writes

`persistTransaction` writes to R2, the queue, and Analytics Engine. If a future destination (Tinybird direct, S3, etc.) needs different sequencing or different retention semantics, the bundling becomes a constraint. Today they share the same redacted shape and org-scoped target set, so the bundle is load-bearing; if those assumptions break, the function splits.

## Outcome

After the refactor:

- **Pipeline stages**: 4 named records that compose. No spread-merged grab-bag.
- **Transaction module**: one type, three functions (`drainCapture`, `buildTransaction`, `persistTransaction`) plus the skip-path companion (`recordSkippedExchange`), all in `apps/proxy/src/transaction.ts`.
- **Provider interface**: one fewer optional method; Google's URL-path quirk lives inside Google (`packages/llm-providers/src/providers/google.ts`).
- **`CaptureContext`**: deleted.

Reversing the Transaction module would force the caller to interleave five concerns inline again. Reversing `CaptureContext` would force nothing — it was a passing record, not a behavior. That asymmetry is what made the two refactors land together.
