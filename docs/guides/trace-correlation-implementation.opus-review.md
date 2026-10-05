# Opus 5.5 implementation review

Persistent session: `77ba62d0-fbed-4d20-bcd8-0466c3a16512`. High effort, fresh context, read-only source review from `/home/dev/code/trace-flow`.

# Trace Flow correlation review (working tree at HEAD `e3643a9` plus uncommitted changes)

**Verdict: changes requested for one P1. Everything else in the local implementation conforms, provided the final CI comes back clean.** This approves nothing for production, deploy or merge.

This was a static review. I didn't run any tests. The working tree changed while I was reviewing: the OTLP scope restoration and the `parentSpanId` fix appeared partway through. That means `/tmp/trace-flow-correlation-review.diff` is stale for `agent-delivery.ts`, `snapshot-runner.ts`, `snapshot-queue.ts`, `otlp/index.ts` and `validateRequest.ts`. The findings below are against the files as they are now.

## P1

**1. After a cold Durable Object (DO) start, some paths record a wrong trace ID instead of none.** This is a gap. It applies only where DOs share an isolate, which is the premise you stated.

- **Root cause in the pinned SDK:**
  - Every instrumented DO constructor creates a new `AsyncLocalStorage` (`@sentry/cloudflare/build/esm/async.js:5`, called from `durableobject.js:14`).
  - At the top of each invocation, the SDK's `init` attaches its client to the isolate's shared default scope (`@sentry/core/build/esm/sdk.js:22-23`). That default scope always has a client after any init.
  - So after a reset, `getActiveSpan()` correctly returns nothing, but `getTraceData()` does not. It falls through to `scopeToTraceHeader(defaultScope)` (`traceData.js:14-29`) and produces a well-formed header carrying one random trace ID per isolate.
  - The SDK's RPC metadata (`rpcMeta.js:10-15`) and `currentSentryTraceContext()` (`sentry-tracing.ts:30-36`) both use `getTraceData()`. They therefore write that shared ID into durable and propagated context.
  - The logger and `internalTraceHeaders` read the active span, so they correctly emit nothing.
- **Remaining failure paths:**
  - **AgentDelivery to a cold coordinator:** the `agent-delivery.ts:199-217` restoration only covers error capture. After `coordinator.getReservation` cold-starts the coordinator in the same isolate, the later calls (`acquireWrite`, `replaceDirtyDays`, `linkDirtyDays`, `finishCommit`) send RPC metadata with the shared trace ID. The coordinator continues that trace, and `recordSnapshotProducer` (`snapshot-tracing.ts:27-31`) stores it durably. Snapshot links then point unrelated deliveries at one shared trace. This is certain under your premise (two DOs in the same script).
  - **Other invocations' cold starts:** restoring per call site only helps when the cold start is your own call. In a streaming Proxy request, `durableCapture` runs at end of stream, possibly minutes after the restoration at `proxy/src/index.ts:88`. If any other invocation cold-starts a DO in that isolate in the meantime, `persistTransaction` (`transaction.ts:402`) stores the shared ID in the envelope and queue message. The same applies to the proxy-consumer producer headers at `proxy-consumer/src/index.ts:339,430`.
- **Fix (two narrow parts):**
  1. **Root cause:** add a `bun patch` for `@sentry/cloudflare@10.73.0` `async.js` so a single module-level `AsyncLocalStorage` is reused. That removes both self-triggered and concurrent resets. It also lets you delete the per-call-site restorations.
  2. **Fail closed:** make `currentSentryTraceContext()` return `{}` when `getActiveSpan()` is undefined, which matches `internalTraceHeaders`.
- **Missing tests:**
  - A no-prewarm DO-to-DO test asserting the coordinator's `snapshot_producer_traces` row has the delivery's trace ID.
  - A Proxy test where request A is streaming, request B cold-starts a UsageTracker, then A finishes. A's envelope trace ID should equal A's trace.

## P2

**2. Skipping remote errors can lose failures.** This is a gap that depends on P1.

- `delivery-queue.ts:23-29` skips capture whenever `error.remote === true`, assuming AgentDelivery already reported it.
- After a reset inside the DO, AgentDelivery's outer catch and the SDK's `onRejected` capture into the default scope. The event is either dropped (client already disposed) or tagged with the shared ID.
- `snapshot-runner.ts` and `snapshot-queue.ts` don't skip, so coordinator errors the DO's RPC wrapper already reported raw are reported again (duplicates).
- **Fix:** do P1(1), then apply the same remote-skip rule wherever the caller sits next to a DO RPC call.

**3. Durable queue context still includes baggage.** This existed before the change and isn't a regression.

- `transaction.ts:402`, `otlp/index.ts:366` and `agent-ingest/src/handler.ts:261` write `currentSentryTraceContext()`, which includes `baggage`.
- That baggage is the Sentry sampling context. It keeps any `sentry-*` baggage entries a customer sends, including arbitrary keys.
- It persists in plaintext in queue messages and in DLQ preservation, which writes `JSON.stringify({queue, messageId, body})` into batcher SQLite.
- This contradicts the change's own rule (`sentry-tracing.ts:59`: only IDs and a sampling bit in plaintext).
- **Fix:** have producers write `{ 'sentry-trace': durableSentryTraceHeader(...) }` only, as `snapshot-schedule.ts:95` already does. Consumers already handle missing baggage.

**4. Convex holds the HTTP response until Sentry finishes sending, up to 2 s.**

- `convexTracing.ts:120-123` awaits `flush(2000)` before the response returns on traced authenticated routes (`httpRoutes/tracing.ts:29`).
- That includes `/worker/authorize-api-key`, which every Proxy auth cache miss waits on with a 5 s timeout (`proxy/src/auth.ts:29`).
- If Sentry ingestion is slow, each call gains up to 2 s.
- **Fix:** use a much shorter flush limit on HTTP routes, or accept and document the cost.
- **Precondition:** with this change, traced requests fail if `SENTRY_DSN` or `SENTRY_ENVIRONMENT` is missing in a Convex deployment. Confirm both are set.

## P3

- **Request data missing after restore:** `proxy/src/index.ts:84-89` and `otlp/index.ts:330` restore scope and span but not the isolation scope. Errors after the UsageTracker call therefore lack the request context. `snapshot-tracing.ts:10-25` already restores the isolation scope; reuse that helper.
- **Two ways of reaching native tracing:** api, pipes-api and mcp use `c.executionCtx.tracing`, while proxy and agent-ingest use `import { tracing } from 'cloudflare:workers'`. The api and pipes-api unit tests mock `tracing`, so only the MCP `SELF.fetch` tests prove it works through the SDK's wrapped context. Prefer the module import everywhere.
- **Sampling flag mismatch:** a `sentry-trace` header with no sampled flag is turned into a W3C `traceparent` with flags `00` (`ingress-tracing.ts:61`), while the SDK still samples it at rate 1. The stored `traceFlags` then disagrees with the actual Sentry sampling.

## Resolved during this review (current tree)

- **Root-span regression:** in the patch version, header-less requests got `ParentSpanId` set to Trace Flow's own internal span ID. That would have hidden every root row from `traces_summary`, `traces_providers`, `traces_models` and `TraceDetail.tsx:59`.
  - The tree now uses the customer's original `traceparent` only (`validateRequest.ts:198-200`, `ingress-tracing.ts:6`).
  - `failure-tracing.integration.test.ts:148` covers the sentry, w3c and no-header cases through `withSentry`.
- **OTLP restoration:** the OTLP route now restores scope after `evaluateRecordingPolicy`.

## Required behaviours

| Check                                           | Result                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stream `tee`, R2 persisted before end of stream | ✓ Logic unchanged by the scope wrapping. Non-streaming responses wait for durable capture. Streaming responses release the capture only after persisting.                                                                                                  |
| Ack and staging order                           | ✓ Body copied to `bodies/${requestId}`, then batcher staging, then `completeTraceDelivery`, then ack. Covers the queue path and DLQ replay (new test). Agent delivery acks only on `complete`.                                                             |
| Idempotent reference contract                   | ✓ Exact receipt match kept. The trace header is loaded once and stored with a `null` sentinel. Old receipts run untraced. No new dependency on the source beyond the existing pricing path.                                                                |
| Plaintext privacy                               | ✓ New stores (`sentryTraceHeader`, `producer_sentry_trace`, `snapshot_producer_traces`) hold IDs only. `captureSafeException` drops message, stack, causes, extra and breadcrumbs. Usage sync no longer logs Convex response bodies. Gap: P2(3).           |
| Async isolation                                 | ✓ Convex uses explicit per-request and per-action scopes, and loggers emit no IDs when nothing is active. ✗ Workers: P1.                                                                                                                                   |
| Sampled and unsampled IDs                       | ✓ Sampling bit handled the same way in `internalTraceHeaders`, durable headers and links. Minor: P3.                                                                                                                                                       |
| Remote error dedupe                             | Partial: P2(2).                                                                                                                                                                                                                                            |
| Causal batch links                              | ✓ Per-row producer context; flush links capped at 32 with an omitted count; snapshot links capped at 32 per day and per generation, cleaned up on finish, erasure and prune; alarm links present.                                                          |
| RPC metadata compatibility                      | ✓ Receivers that take optional trailing parameters (`getSnapshotProgress`, `addMessageTraces`) are RPC-instrumented, so the metadata argument is stripped. Agent-ingest calls into agent-consumer pass every argument explicitly, so deploy order is safe. |

Platform limitations as you described them, not regressions: native Cloudflare and Sentry IDs can't be unified, deployed native OTLP export is unverified, and the two Convex generated argument types were edited by hand.
