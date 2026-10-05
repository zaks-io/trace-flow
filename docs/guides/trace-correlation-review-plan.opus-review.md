> Review provenance: Claude Code, model `claude-opus-5-5` (verified in CLI model usage), fresh read-only session, 2026-10-04. Reviewed the original draft against code baseline `257b3285682f59c9015187d6558da4168469c0b4`. The reviewer used 80 turns with no tool permission denials. The primary agent saved this verbatim report after the read-only reviewer finished; its opening note describes the reviewer's permissions at the time. Subsequent plan revisions and dispositions are recorded in the plan. This is plan review, not implementation approval.

# Independent review: trace-correlation code-review plan

The plan expects `trace-correlation-review-plan.opus-review.md`, but I only had read-only tools, so this report is not saved anywhere yet. It needs to be saved to that path.

## Baseline, scope and verdict

- **Code reviewed:** `257b328` on `main`. The only uncommitted file is the plan itself (`docs/guides/trace-correlation-review-plan.md`).
- **What I read:**
  - Repo policy: `AGENTS.md`, `CONTEXT.md`, the workflow config, review invariants, and the `ziw-code-review` skill and checklist.
  - Ingress and logging: Proxy pipeline, queue and delivery code, `transaction.ts`, the usage tracker, and `packages/logging`.
  - Queue consumers: the Proxy Consumer entry, `TraceBatcher`, and the agent-ingest handler and entry.
  - Agent consumer: entry, delivery queue, `AgentDelivery`, legacy consumer, and the shared agent-delivery validator.
  - Other surfaces: Convex Tinybird tracing and HTTP routes, the MCP Sentry wrapper, web Sentry setup and CORS, and `wrangler` observability configs, plus the deploy job order.
- **Evidence I could not get:**
  - The pinned SDK source isn't installed. `bun.lock` resolves `@sentry/cloudflare@10.73.0`, but there is no `node_modules/@sentry`.
  - No hosted deployment metadata, Sentry, Axiom or Cloudflare dashboard data was available.
  - Every claim below about SDK or runtime behaviour is marked as needing runtime verification.

**Verdict: NEEDS REVISION.** The plan's structure is sound. The fixes below are needed first because some leads point the remediation at the wrong layer, and two corrections prevent breaking changes.

## Material findings about the plan

### F1 — The log `trace_id` field has three meanings, and none is the Sentry trace (P1, confidence 9, source-verified)

- `createWorkerLogger` fills `trace_id` from the incoming W3C `traceparent` only (`packages/logging/src/index.ts:403-421`, `:462-478`).
- In the Proxy, that header comes from the customer. If it's missing, the Proxy makes up a random ID (`apps/proxy/src/pipeline/validateRequest.ts:189-204`).
- `TraceBatcher` logs the Tinybird span's `TraceId` (`apps/proxy-consumer/src/batcher.ts:276-278`).
- `UsageTracker` makes up a random workflow trace ID (`apps/proxy/src/usage-tracker.ts:70-76`).
- The consumer batch logger has no trace context at all (`apps/proxy-consumer/src/index.ts:349-356`).
- The browser sends `sentry-trace`, not `traceparent` (`apps/web/src/lib/trace-propagation.ts:25-41`; whether the SDK default omits `traceparent` needs runtime verification).

**Consequence:** the 65/17,721 and 0/N Axiom counts measure customer or app-workflow IDs, not operational correlation. The zeros are expected given how the code works.

**Plan change:** before step 2, add a "field contract" deliverable that names each ID (customer/imported, app workflow, Sentry operational, native Cloudflare) and its log field. Re-run the baseline query only after that.

### F2 — Public ingress has no trust boundary in the plan (P1, confidence 7; SDK behaviour needs runtime verification)

- The Proxy (`apps/proxy/src/index.ts:185-194`) and MCP (`apps/mcp/src/index.ts:513-523`) wrap public traffic in `withSentry` with no guard on incoming trace headers.
- A customer's Node app with Sentry installed will commonly send `sentry-trace` and `baggage` to the gateway. Our Proxy transaction may then join the customer's trace and follow their sampling decision.
- At the gateway, `traceparent` is customer identity. It is carried into the queue message (`apps/proxy/src/queue.ts:143-157`) and must never become our operational parent.
- Step 3's single precedence matrix (W3C-only, Sentry-only, conflicting, and so on) assumes every ingress is the same kind.

**Plan change:** classify each ingress as internal (browser → api/pipes-api, Worker → Worker) or public (gateway, `/v1/traces`, MCP, collector). Add these cases:

- A `sentry-trace` from a foreign Sentry org with `sampled=0`.
- A customer `traceparent` that leaves the operational trace unchanged.

Verify the pinned SDK's org-ID and strict-continuation behaviour from its source.

### F3 — The trace context is already stored durably; the recovery leads point at the wrong layer (P1, confidence 9, source-verified)

**Proxy:**

- `currentSentryTraceContext()` is written into the envelope's `message` (`apps/proxy/src/transaction.ts:366`, `apps/proxy/src/delivery.ts:32-37`).
- The sweep drops only the queue-reference copy (`delivery.ts:95-98`).
- The consumer groups messages by the reference's context (`proxy-consumer/src/index.ts:406`) before it loads the envelope (`:216-228`).
- So the fix is on the consumer side, with no wire change.

**Agent:**

- The context sits inside the encrypted plaintext (`apps/agent-ingest/src/handler.ts:259-261`, `packages/utils/src/agent-delivery.ts:115-126`).
- The reference validator accepts only an exact set of keys (`packages/utils/src/agent-delivery.ts:63-76`).
- Register is idempotent by comparing the stringified reference (`apps/agent-consumer/src/agent-delivery.ts:88-95`).
- An invalid reference is retried until it dead-letters (`apps/agent-consumer/src/delivery-queue.ts:15-22`).
- **Adding a context field to the reference is therefore a breaking change.**

**Plan change:**

- Prefer reading the context from the decrypted envelope.
- If the reference must change, roll out readers first, keep the context out of the idempotency identity, and cover consumer rollback and DLQ replay of the new shape.
- Deploy order is consumer-first today (`.github/workflows/deploy.yml:245`, `:488`, `:534`).

### F4 — Uninstrumented RPC entrypoints; "RPC matching" is framed too narrowly (P1, confidence 8)

- `AgentIngestion` (`registerDelivery`, `canAcceptDeliveries`) and `TraceRecovery` are `WorkerEntrypoint` classes outside `withSentry` (`apps/agent-consumer/src/index.ts:196-226`, `apps/proxy-consumer/src/index.ts:588-622`).
- `TraceRecovery` calls the DO through the raw `this.env` (`:595`).
- The agent-ingest `withSentry` config has no `enableRpcTracePropagation` (`apps/agent-ingest/src/index.ts:41-48`).
- The caller of the recovery entrypoints, `scripts/ingest-recovery/` (`wrangler.jsonc` binds `TraceRecovery`), is missing from the path table.

**Plan change:**

- Add these entrypoints and the recovery Worker to the path table.
- Check whether SDK 10.73 can instrument entrypoints.
- Verify that an instrumented DO handles a call that arrives without the trailing RPC metadata.

### F5 — An existing manual W3C propagation to Convex contradicts AGENTS.md (P2, confidence 9)

- `UsageTracker` is a plain `DurableObject` with no Sentry (`usage-tracker.ts:67`).
- It sends `traceparent` and `baggage` to Convex (`:52-61`). Those headers carry `org_id`/`user_id` (`packages/logging/src/index.ts:480-512`).
- Convex reads them (`packages/convex/httpRoutes/usage.ts:12`, `shared.ts:19`).
- AGENTS.md:49-51 says trace headers must never reach Convex.
- The `claim-sessions` route reads a trace context that agent-ingest never sends.

**Plan change:** list this as an existing app-level boundary that isn't Sentry. Record a decision to either document it or remove it. Audit manual header writers alongside `tracePropagationTargets`.

### F6 — Missing hand-off and causality edges (P2, confidence 8)

| Edge                                                             | Location                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `AgentDelivery.finishCommit` queues the **next** delivery's wake | `agent-delivery.ts:332-346`                                                  |
| Alarm republish                                                  | `agent-delivery.ts:294-304`                                                  |
| Expired-delivery event                                           | `agent-delivery.ts:286-289`                                                  |
| Inline flush inside whichever RPC crosses `BATCH_SIZE`           | `batcher.ts:287-289`                                                         |
| Alarm flush                                                      | `batcher.ts:302-314`                                                         |
| Health-check `forceFlush`                                        | `proxy-consumer/src/index.ts:512-514`                                        |
| DLQ preservation (body context available but unused)             | `proxy-consumer/src/index.ts:315-345`, `agent-consumer/src/index.ts:102-147` |

The wake must **not** inherit the current trace, or delivery B gets attributed to delivery A.

### F7 — The pipeline inventory is missing pieces (P2, confidence 8 source; hosted config unverified)

- Every Worker sets native `destinations = ["axiom-traces"]` and `["axiom-logs"]` plus `logpush = true` (`apps/proxy/wrangler.toml:7-20` and the other apps).
- The logger writes to the console by default and also sends to Axiom directly (`packages/logging/src/index.ts:347-369`). The native log export of those console lines may carry native trace IDs.
- The claim that the native trace was "accessible in Sentry" needs the hosted destination checked.
- Logpush is a third pipeline the plan doesn't name.

### F8 — Convex isolation is intentional, and the realistic fix is different (P2, confidence 8)

- The isolation is deliberate (`packages/convex/tinybirdTracing.ts:16-17`; `parentSpan: null` at `packages/tinybird-client/src/tracing.ts:28`).
- The browser reaches Convex through the Convex client, with no trace headers (`trace-propagation.ts:10-11`).
- Each `fetchPipe` or `runAdminSql` call creates its own client (`tinybirdTracing.ts:56-62`). One action with N queries therefore produces N separate traces.
- **Fix direction:** one root span per action. Cross-boundary propagation only where explicit arguments exist.
- `apps/analyst-sandbox` has no Sentry SDK at all.

### F9 — Order of work (P2, confidence 9)

- Steps 1 and 3 depend on the pinned SDK source, but step 5 defers the frozen install. Move the install (or a read of the published tarball) into step 1.
- The Vitest/Turbo/Cargo limits aren't in repo config, so commands must pass them explicitly.

## Status of the initial leads

| Lead                                        | Assessment                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native/SDK R2 dual trace                    | Unresolved. Can't be verified from source; the destination names conflict with "in Sentry" (F7).                                                                                                                                                                                                                                               |
| Axiom counts                                | Overstated as a correlation metric (F1).                                                                                                                                                                                                                                                                                                       |
| W3C and Sentry readers differ               | Supported (`logging:462-478` vs the SDK), but framed wrongly as a precedence question (F2).                                                                                                                                                                                                                                                    |
| Agent references omit context               | Supported for the reference; overstated as lost (F3).                                                                                                                                                                                                                                                                                          |
| Proxy recovery drops context                | Supported for the reference; the context survives in the envelope (F3).                                                                                                                                                                                                                                                                        |
| Batch submission leaves producer scopes     | Supported, and documented as intentional (`proxy-consumer/src/index.ts:403-405`, `agent-consumer/src/consumer.ts:176-179`). The real gap is missing links and trigger-request attribution.                                                                                                                                                     |
| Caught errors only logged                   | Supported. `packages/logging` imports no Sentry; examples at `apps/proxy/src/index.ts:79`, `:121`, `:128` and `proxy-consumer/src/index.ts:397`, `:441-445`. No Hono app defines `onError`, so default capture depends on the SDK (runtime verification). Double-reporting candidate: `apps/mcp/src/sentry.ts:184-190` captures then rethrows. |
| Convex isolated spans                       | Supported; intentional (F8).                                                                                                                                                                                                                                                                                                                   |
| `buildUpstreamHeaders` keeps `sentry-trace` | Supported (`forwardToUpstream.ts:30-38`). Lower severity: it passes through the caller's own header, and our targets exclude providers (`sentry-tracing.ts:21-26`). Verify the SDK leaves pre-existing headers alone.                                                                                                                          |

## Tests: what they prove, and additions

The plan's eight behaviour areas are the right ones. However:

- Trace-ID equality alone doesn't prove parentage. Assert that the consumer's `parent_span_id` equals the producer's span ID, and that two interleaved requests stay isolated as siblings.
- Today's integration tests mock Sentry (`proxy-consumer/src/__tests__/index.integration.test.ts:37`, `agent-consumer/src/__tests__/index.integration.test.ts:15`).
- `@cloudflare/vitest-pool-workers` is already set up in proxy, mcp, agent-ingest and both consumers. Use it with the real `@sentry/cloudflare` and a capturing transport (or `beforeSendTransaction`) to prove:
  - ingress continuation,
  - `waitUntil` and streaming context,
  - DO RPC metadata, including calls without metadata,
  - queue continuation.
- Native Cloudflare traces can only be checked in dev or live.

**Add these cases:**

- Foreign-org or unsampled `sentry-trace` at the gateway.
- A customer `traceparent` never becomes our parent, and operational IDs never reach Tinybird rows.
- Swept, DLQ-replayed and alarm-republished deliveries get their context from the envelope, and different producers are never merged.
- A wake reference doesn't inherit the current trace.
- Reader-first wire compatibility and consumer rollback.
- Log `trace_id` semantics follow the field contract.

## Revised order of work

1. Frozen install and SDK source; read-only hosted metadata and destination config.
2. Identifier taxonomy and field contract; ingress trust classes.
3. Boundary matrix, including the paths from F4 to F6.
4. Runtime proofs in workerd.
5. Logs and errors.
6. Transport recovery (consumer side first).
7. Causal links for async work.

## Correction list for the author

1. Add the field contract step before measuring logs (F1).
2. Add ingress trust classes and the foreign-trace and customer-`traceparent` cases (F2).
3. Restate the recovery leads: the context survives in the envelope; fix on the consumer side; respect the exact-key validator and register idempotency (F3).
4. Add the `AgentIngestion` and `TraceRecovery` entrypoints, the agent-ingest RPC option, and `scripts/ingest-recovery/` (F4).
5. Add `UsageTracker` → Convex W3C propagation and the `logging` header writers (F5).
6. Add the wake, alarm, inline-flush, health-check and DLQ edges (F6).
7. Add native destinations and Logpush to the inventory; verify the "in Sentry" claim (F7).
8. Reframe Convex as isolated by design, with a fix of one span per action (F8).
9. Move the frozen install into step 1 (F9).
10. Require real-SDK workerd tests that assert parent span IDs.

## Open architecture questions

- Should public ingress ever continue a caller's Sentry trace?
- Is Proxy → Convex W3C propagation an approved internal boundary? AGENTS.md would need updating either way.
- Should the domain `trace_id` log field be renamed? That affects existing Axiom queries.
- Can code read the native Cloudflare trace ID? If not, which shared key (R2 key, `cf-ray`) does the mapping use?
- Should recovery work that's late (swept after 5+ minutes per `delivery.ts:21`, or DLQ-replayed days later) continue the original trace or link to it?
