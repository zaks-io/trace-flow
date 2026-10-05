# Trace correlation code-review plan

Date: 2026-10-04  
Code baseline: `257b3285682f59c9015187d6558da4168469c0b4`  
Status: Audit completed; see [audit report](trace-correlation-audit.md)

## Objective and scope

Audit how an execution is correlated across Cloudflare native tracing, Sentry SDK
spans and exceptions, application logs, queues, Durable Objects, Convex, and
Tinybird. Produce a source-backed gap report and a dependency-ordered remediation
proposal. This document authorizes review and planning, not implementation,
deployments, tracker changes, or production test traffic.

The later instruction, “Complete the audit then and continue,” authorized local
remediation. The completed audit uses baseline `e3643a9`, which includes the
native Sentry export added after this plan's initial baseline. The original Opus
plan reviews remain historical evidence, not implementation approval.

The goal is an understandable execution timeline. A synchronous execution should
share an operational trace ID across supported boundaries, with a distinct span
ID for each operation and accurate parentage. Batch, scheduled, recovery, and
long-lived work may require separate traces with explicit causal links.
Customer/imported OTel trace IDs, LLM request IDs, collector batch IDs, delivery
keys, workflow IDs, and native agent session IDs retain their domain meanings.
Do not collapse unrelated executions or rewrite imported trace identity to make
an infrastructure trace look continuous.

## Starting evidence and questions

The first pass reviewed the baseline code, published Sentry SDK 10.73.0 source,
and read-only production telemetry. Treat these observations as leads to verify,
not predetermined architecture decisions:

- **Live confirmation:** one R2 object write was present under native Cloudflare
  trace `273bbb95d1a6482e050d7e567f578b47` and SDK trace
  `9c6f03e3933047dfbf3206924f1487ff`. Matching the exact object key established
  that this was the same write, not just coincident requests. Both trace trees
  were accessible in Sentry. Determine which supported runtime mechanisms can
  bridge these contexts, and which require explicit mapping or links.
- **Live confirmation:** a bounded 24-hour Axiom query on application records
  found trace IDs on 65/17,721 Proxy Worker records, 0/5,662 Proxy Consumer
  records, and 0/3,611 Web Worker records. This query covered the application's
  direct structured-log ingest, not all native Cloudflare exported logs.
  These are field-population counts, not a measure of operational trace coverage:
  existing `trace_id` values can mean customer, domain, or workflow IDs.
  Distinguish these pipelines and establish field semantics before measuring
  operational coverage. The independent reviewer had no live access, so the
  native/SDK observation remains primary-agent live evidence to revalidate.
- **Code leads:** W3C and Sentry header readers differ; durable agent references
  omit trace context; Proxy recovery republishes references without context;
  consumer batch submission leaves producer-specific scopes; some caught
  exceptions are only logged; Convex queries start isolated spans. Context
  survives in both Proxy envelopes and encrypted agent payloads; investigate
  restoring it at consumption before proposing changes to reference shapes.
  Batch and Convex scope isolation are intentional; review their causal links
  and per-action grouping rather than treating isolation itself as a bug.
- **Behavioral reproduction:** `buildUpstreamHeaders` preserved an incoming
  `sentry-trace` while removing `traceparent` and `baggage`. Investigate every
  outgoing boundary, not only automatically injected SDK headers.

## Work sequence

External research is recorded in
[trace-correlation-research.md](trace-correlation-research.md). It was added after
the Opus reviews and has not been independently reviewed. Current Cloudflare docs
explicitly lack native trace/span ID access and manual parent wiring; treat a
native/SDK bridge as a runtime feasibility question, with an attribute-based
mapping as a candidate fallback to prove. Sentry v11 improves application-owned
OTel interoperability but does not establish a bridge to the native runtime.
The audit below remains against pinned 10.73.0; assess migration separately.

### 1. Establish the actual instrumentation and deployment baseline

Read `AGENTS.md`, `CONTEXT.md`, the workflow config, review invariants, OTel and
queue ADRs, bounded-agent-ingestion ADR, and trace delivery recovery guide.
Record local HEAD and working-tree state. Check read-only hosted deployment
metadata before using production evidence to make claims about this code.
Record deployed version IDs and any code drift; do not assume local HEAD is
deployed. Inventory SDK versions from manifests and the lockfile.
Obtain pinned SDK source in this step through a frozen dependency install or
read-only published package inspection, before interpreting framework behavior.

Inspect all Worker wrappers, Durable Object wrappers, web browser/server/edge
initialization, `wrangler` observability settings, and exporter configuration
where accessible. Separate native instrumentation, SDK instrumentation, direct
Axiom ingestion, native log export, Logpush, and Sentry Logs. Source names only
`axiom-traces` and `axiom-logs` destinations: inspect hosted destination and
forwarding configuration to explain how native spans reach Sentry. Account for
console emission plus direct ingestion of the same structured records. Verify framework defaults
against the pinned SDK source, including Hono error handling, asynchronous scope
isolation, `waitUntil` context lifetime, streaming span completion, and RPC
metadata conventions. Record hosted settings unavailable from source as unknown.

Deliverable: instrumentation inventory with owner, environment, destination,
sampling, context source, error capture, and deployment evidence for each surface.

### 2. Map execution paths and identifier ownership

First establish an identifier and field contract. Distinguish customer/imported
OTel identity, application workflow identity, Sentry operational identity, and
native Cloudflare identity. Record present meanings of `trace_id`, `span_id`,
`parent_span_id`, and request/delivery fields in each pipeline; propose explicit
operational and domain fields without silently renaming existing query contracts.
After defining the contract, measure its field coverage separately by pipeline.

Classify trace-context ingress by trust, independently of whether the endpoint
is internet-accessible: same-application browser calls, authenticated service
calls, customer gateway/OTLP requests, MCP clients, and collector uploads.
Include Convex HTTP actions as ingress: their header readers populate log context
from caller-provided W3C headers and baggage.
Authentication alone does not prove incoming trace/baggage ownership. Inspect
Sentry's organization-ID and strict-continuation behavior in the pinned SDK.
Decide and document where external traces may be continued, linked, or ignored;
do not assume a customer's W3C parent is automatically our operational parent.
Preserve intentional external correlation as a design question, not a ban.

Trace callers and callees through these paths:

| Path                                                                        | Source starting points                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxied LLM call, stream/non-stream, failures                               | `apps/proxy/src/index.ts`, `pipeline/validateRequest.ts`, `pipeline/forwardToUpstream.ts`, `pipeline/respond.ts`, `transaction.ts`, `queue.ts`, `delivery.ts`                                                                                                                                |
| Proxy delivery, shard staging, flush, alarm, sweep, DLQ/replay              | `apps/proxy-consumer/src/index.ts`, `batcher.ts`, `ledger.ts`, `tinybird.ts`; `docs/guides/trace-delivery-recovery.md`                                                                                                                                                                       |
| OTLP ingestion and imported execution identity                              | `apps/proxy/src/otlp/index.ts`, `otlp/transform.ts`, `otlp/imported/`; `packages/otel-conventions`                                                                                                                                                                                           |
| Collector upload, durable registration, queue, delivery, snapshot, recovery | `packages/collector-api-client/src/client.rs`; `apps/agent-ingest/src/index.ts`, `handler.ts`; `apps/agent-consumer/src/index.ts`, `delivery-queue.ts`, `agent-delivery.ts`, `agent-delivery-coordinator.ts`, `snapshot-queue.ts`, `snapshot-runner.ts`, `legacy-delivery.ts`, `consumer.ts` |
| Service RPC entrypoints and operator recovery                               | `AgentIngestion` and recovery entrypoints in `apps/agent-consumer/src/index.ts`; `TraceRecovery` in `apps/proxy-consumer/src/index.ts`; `scripts/ingest-recovery/worker.mjs`, `scripts/ingest-recovery/wrangler.jsonc` and callers                                                           |
| Browser navigation and analytics/body reads                                 | `apps/web/src/instrumentation-client.ts`, `sentry.*.config.ts`, `worker-entry.ts`, `lib/trace-propagation.ts`, `lib/tinybird.ts`, `lib/bodies.ts`; `apps/api/src/index.ts`, `apps/pipes-api/src/index.ts`                                                                                    |
| MCP tool execution and Analyst calls                                        | `apps/mcp/src/index.ts`, `sentry.ts`; `packages/mcp-core/src/handler.ts`, `tinybird.ts`; `apps/analyst-sandbox/src/index.ts`; `packages/convex/analystSandbox.ts`                                                                                                                            |
| Usage authorization and billing synchronization                             | `apps/proxy/src/usage.ts`, `usage-tracker.ts`; `packages/convex/httpRoutes/usage.ts`, `httpRoutes/shared.ts`                                                                                                                                                                                 |
| Convex actions, HTTP handlers, Tinybird queries                             | `packages/convex/tinybirdTracing.ts`, `httpRoutes/agentIngest.ts`, `httpRoutes/shared.ts`; `packages/tinybird-client/src/tracing.ts`, `fetchPipe.ts`, `runAdminSql.ts`                                                                                                                       |
| Shared transport, IDs, logging, and validation                              | `packages/utils/src/sentry-tracing.ts`, `trace-context.ts`, `agent-delivery.ts`; `packages/logging/src/index.ts`; `packages/types/src/{sentry,queue,agent-delivery,agent-ingest}.ts`                                                                                                         |

For each boundary record: producer and consumer, transport, read/write locations,
operational trace ID, active span and parent span, sampled flag and baggage,
request/delivery/domain identifiers, context persistence, retry behavior, and
whether errors and logs use the same context. Include rejected requests that
exit before LLM request IDs are assigned.

Explicitly include next-delivery wakes, alarm republishes, delivery expiration
events, size-triggered inline flushes, alarm flushes, health-check `forceFlush`,
and DLQ preservation/replay. A delivery A waking delivery B is a causal link;
it must not replace B's own producing identity with A's context. A size-triggering
request must not become the apparent owner of all unrelated rows in a flush.
Include `/internal/organization-erasure` -> `AgentIngestion.eraseOrganization`
alongside registration and admission-check RPCs. The operator recovery Worker's
configuration includes production bindings: inspect its source and configuration
only; do not run or deploy it as part of this audit.

Deliverable: identifier/field contract, ingress trust matrix, boundary matrix,
and a few representative sequence diagrams. Mark
each edge as continued, linked, independent by design, broken, or unverifiable.

### 3. Verify context semantics and isolation

Review header precedence and validation for valid W3C-only, Sentry-only, matching
both, conflicting both, absent, malformed, and unsampled contexts. Verify the
SDK's incoming and outgoing behavior rather than assuming enabling outbound
`traceparent` also handles incoming W3C context. Establish how root creation and
parent-span assignment behave for each ingress trust class. Include foreign-org
Sentry context, forged same-org baggage, unsampled external parents, and domain
trace identity independent of operational identity. The expected continuation
and sampling outcomes depend on the explicit policy chosen during the audit.

Evaluate native Cloudflare/Sentry interoperability using the current supported
runtime APIs and vendor documentation. Do not propose invented APIs, disabling
instrumentation as a shortcut, or claiming a single shared ID without a working
proof. If a runtime cannot adopt external trace identity, specify an explicit
mapping/link and its retrieval path.

Check asynchronous work and concurrent requests for context leakage. In queue
batches, distinguish producer groups from mixed-producer flushes. Verify context
survives encrypted staging, reference publication, redelivery, alarm recovery,
DLQ preservation, and manual replay. Determine when continuing an old trace is
useful and when a new trace with links is required by retention or runtime limits.

Prefer restoring persisted producer context on the consumer side before adding
fields to queue references. For Proxy sweep references, the envelope must be
loaded before choosing its producer trace. For agents, evaluate where decrypting
the payload can resume context and which pre-decryption spans need causal links.
Account for additional R2 reads, size limits, encryption and delivery lifetimes.
If a reference change is necessary, include reader-first rollout, old/new
producer-consumer combinations, rollback, DLQ compatibility, and keeping
observability metadata out of idempotency identity. The exact-key reference
validator and stringified-reference registration comparisons are explicit review
constraints, not incidental implementation details.

Check named `WorkerEntrypoint` classes as well as default Worker exports: they
must not be assumed covered by `withSentry`. Inspect caller, entrypoint, raw
`this.env` bindings, and receiving DO instrumentation. Verify supported SDK
entrypoint wrappers and DO handling of RPC calls with and without trailing
metadata; matching flags on default exports alone are insufficient evidence.
Explicitly inspect Agent Ingest's caller-side `enableRpcTracePropagation`, absent
from its current wrapper, and the registration, admission, and organization
erasure paths before changing propagation settings.
Pinned 10.73.0 already supports `rpcTracePropagationBindings` as a caller allowlist,
while its receivers still require the old boolean. V11 removes that boolean and
wrapped receivers automatically inspect incoming metadata. Verify the version in
use before applying either rule; a migration is not required to assess caller
allowlists today.

For Convex, preserve per-action concurrency isolation. Evaluate one action-level
root with child query spans for actions that run multiple queries: today each
wrapper call creates a separate client/scope. Cross-boundary correlation needs
supported explicit arguments or another proven mechanism, not shared global
scopes or unsupported browser-to-Convex headers. Inventory Analyst Sandbox's
native tracing separately because it has no Sentry SDK wrapper.

Deliverable: proposed identity and parentage contract, compatibility constraints,
and small reproductions for uncertain runtime behavior.

### 4. Audit logs, errors, privacy, and operational usefulness

Enumerate caught failures, rethrows, retryable outcomes, HTTP error responses,
and stream errors. Check what actually becomes an exception, breadcrumb, log, or
errored span through framework defaults. Do not assume `logger.error` captures a
Sentry event or capture every expected rejection/retry as an exception. Avoid
double reporting an exception already captured by a wrapper or RPC callee.

Define how log records obtain the active operational trace and span at emission,
including early exits and background work. Keep domain trace IDs in separate
fields when needed. Examine service/environment/release tags, sampling decisions,
duplicate native/SDK spans and logs, and missing links on batch-level failures.
Assess correlation identifiers on HTTP error responses without changing public
response shapes or exposing customer data in this planning task.

Audit copied headers as well as automatic propagation targets and CORS policies.
Trace headers must not reach LLM providers, Tinybird, Auth0, or Convex unless an
explicitly supported internal tracing boundary is established for that service.
Record the existing UsageTracker -> Convex W3C header/body propagation and the
conflict with `AGENTS.md`'s no-Convex-propagation rule. Inspect the agent session
claim route's header reader and its producer. Whether to preserve/document or
remove the usage-sync boundary is an explicit policy decision, not authority to
change instructions during this audit. Distinguish forwarding a caller's existing
`sentry-trace` from leaking newly generated internal context; both must be
evaluated against the boundary contract.
Never include credentials, raw transcripts, request/response bodies, signed
URLs, or unbounded/high-cardinality payload attributes in reports or telemetry.

Deliverable: severity-ranked findings with exact source citations, concrete
failure paths, confidence, existing mitigations, and the smallest fix direction.

### 5. Specify meaningful verification before remediation

Use existing tests and fixtures first. Install frozen dependencies only if needed
for focused verification beyond the pinned-source inspection in step 1. Do not
start the local backing stack for an ordinary audit. Pass Vitest `--maxWorkers=2`,
Turbo `--concurrency=2`, and Cargo `-j 4` explicitly, using smaller repo limits
where present. Browser verification uses the T3 collaborative
preview; CLI/Desktop tests use dev ingest and Convex endpoints.

Specify behavior checks for:

1. Header precedence, ID preservation, parentage, sampling, malformed headers,
   and separation of operational and imported/customer identities.
2. Proxy producer -> durable envelope -> queue reference -> consumer -> DO,
   including failed publication, sweep recovery, old messages, and replay.
3. Durable agent references and registration RPC, encrypted payload reload,
   alarms, recovery, and compatibility with legacy inline queue messages.
4. Concurrent HTTP executions and mixed-producer queue batches with no context
   bleed, false shared parentage, or first-item attribution for the whole batch.
5. Unexpected failures recorded once with useful trace/span/delivery identity;
   expected auth, rate-limit, gate-closed, and retry outcomes handled deliberately.
6. Streaming completion, capture failures, `waitUntil` work, and client aborts,
   preserving both consumed tee branches, the R2-before-terminal-EOF durability
   gate, and acknowledgement only after durable staging/handoff.
7. Browser -> raw/pipes API propagation and preflight behavior; MCP tool and
   Convex query correlation where supported; no outgoing third-party trace leaks.
8. Active-context log fields and bounded causal links on batch/scheduled work.

Prefer real SDK/runtime integration evidence for propagation claims. Mocks of
`getTraceData` or `continueTrace` alone cannot prove interoperability. Production
and native Cloudflare traces cannot be proved by local SDK tests alone. Existing
consumer integration tests mock Sentry. Use the existing workerd/Vitest Worker
test setup with the real pinned SDK and a capturing transport or transaction
hook for ingress, queue continuation, streaming/`waitUntil`, and RPC behavior.
For span-streaming mode, capture actual emitted spans rather than relying on
transaction hooks. V11 defaults to streaming and no longer applies scope tags or
extra to spans; verify correlation attributes, explicit data-collection settings,
and cross-request error deduplication if migration is proposed.
Assert exact parent span IDs as well as trace ID equality, sibling relationships,
and isolation of interleaved concurrent executions. Include calls without RPC
metadata, foreign-org and unsampled ingress under the selected policy, recovering
context from envelopes, next-delivery wakes, and reader-first rollback cases.
Never insert operational IDs into imported customer rows just to satisfy a test.

Production validation is read-only and time-bounded, with exact shared operational keys;
do not infer a match from timestamps alone. Use authorized dev traffic only for
new test requests; request approval before hosted mutations or manual deploys.

Deliverable: verification matrix naming current coverage, missing behavior checks,
required runtime proofs, and observational acceptance criteria.

### 6. Produce the remediation proposal

After confirming the audit findings, propose the smallest dependency-ordered
changes: establish context semantics, add shared adapters and log integration,
repair transport persistence/continuation, handle causal links for asynchronous
work, and improve selective error capture. Actual order depends on validated
findings and SDK/runtime constraints, not this initial list.

For each proposed change include affected files/packages, wire compatibility,
privacy and sampling implications, resource overhead, verification, rollout and
rollback, and independent review requirements. Do not create tracker tickets or
implement changes during this planning task.
Inspect `.github/workflows/deploy.yml` to verify the current consumer-first job
dependencies before relying on reader-first rollout, including the relevant
Proxy and Agent Consumer/producer pairs; do not infer rollout order from source
file order or assume it remains unchanged.

## Completion criteria

- Every listed execution path has a boundary matrix backed by source evidence;
  unsupported or unavailable runtime behavior is explicitly marked.
- The native/SDK split is explained with deployment and runtime evidence, and
  proposed interoperability has a feasible proof or explicit linked fallback.
- Logs and exceptions can be located from an execution ID across supported
  boundaries, or the exact missing edge and its proposed remedy are documented.
- Imported identity, tenancy, redaction, queue durability, and streaming semantics
  are preserved in the proposal; compatibility and sampling are explicit.
- Findings distinguish live-confirmed behavior, source-confirmed failure paths,
  intentional independent traces, and unresolved questions.
- Opus 5.5 independently checks the plan against source, identifies unsupported
  assumptions or omissions, and its material feedback is recorded and resolved
  before this plan is treated as ready to execute.

## Independent plan review

Requested reviewer: Opus 5.5 (`claude-opus-5-5`), fresh read-only Claude Code session.  
Review status: Completed; final verdict **READY TO EXECUTE as a read-only audit**.  
Original report: [Opus first review](trace-correlation-review-plan.opus-review.md).  
Correction check: [Opus correction check](trace-correlation-review-plan.opus-correction-check.md).

Reviewer task: read this plan and relevant repository policy, then inspect the
actual source at the baseline. Challenge the initial findings, check scope and
execution order, identify missed paths and unsafe assumptions, and assess whether
the proposed tests would prove trace correlation. Cite files and lines for each
material finding. Return a plan verdict and concrete corrections; do not edit
product code, create issues, invoke hosted review bots, or mutate external systems.

### First-review disposition

Opus 5.5 reviewed the original draft against source in a fresh read-only session
and returned **NEEDS REVISION**. The original report is retained in
[trace-correlation-review-plan.opus-review.md](trace-correlation-review-plan.opus-review.md).
It had no SDK installation or hosted telemetry access. The revised plan applies
the material corrections as follows:

| Finding                                    | Disposition in this revision                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: overloaded log trace fields            | Added the identifier/field contract before interpreting coverage; relabeled counts as field population. IDs can happen to coincide, so "none is Sentry" remains a source-contract concern, not an absolute claim about all values. |
| F2: ingress trust boundary                 | Added trust classes and foreign/unsampled/spoofed cases; kept external continuation and customer-parent handling as explicit policy questions. A categorical ban is not established by the user's request or existing policy.      |
| F3: durable context and wire compatibility | Clarified that envelopes retain context; prefer consumer restoration. Added exact-key validation, idempotency, reader-first rollout, rollback and DLQ compatibility constraints for any necessary wire change.                     |
| F4: RPC entrypoints                        | Added named entrypoints/operator recovery and required proof for raw bindings, supported wrappers and calls without metadata.                                                                                                      |
| F5: manual Convex propagation              | Added the existing boundary and instruction conflict as a decision to resolve, without changing policy.                                                                                                                            |
| F6: causality edges                        | Added wakes, alarms, expiration, inline/forced flushes and DLQ paths; preserve the target delivery's own identity.                                                                                                                 |
| F7: pipeline inventory                     | Added Logpush/console duplication and hosted destination verification. The live native span in Sentry is primary-agent evidence; source alone does not explain its forwarding configuration.                                       |
| F8: Convex/Analyst                         | Preserved intentional isolation; evaluate action-level grouping and explicit cross-boundary mechanisms. Added Analyst's native-only instrumentation to the inventory.                                                              |
| F9: source/check prerequisites             | Moved pinned SDK source inspection into step 1 and made resource flags explicit.                                                                                                                                                   |

Open decisions for the audit: external trace continuation and sampling policy;
the approved usage-sync/Convex boundary; log-field compatibility; supported native
trace access/bridging; and continuation versus links for delayed work. These do
not block executing a read-only audit; they block implementation choices that
depend on their answers.

A focused fresh-session Opus 5.5 correction check confirmed F1-F9 resolved and
returned **READY TO EXECUTE as a read-only audit**. Its four non-blocking
clarifications (D1-D4) were applied afterward: explicit caller-side RPC and
organization erasure coverage; Convex HTTP ingress classification; inspection-only
handling of the production-bound recovery Worker; and deployment dependency
verification. These final documentation clarifications have not received a third
review. Neither review is implementation or merge approval.

## Done

- An instrumentation, identifier, trust-boundary, and execution-path inventory
  is recorded in [trace-correlation-audit.md](trace-correlation-audit.md).
- Findings distinguish live observations, pinned SDK behavior, code evidence,
  verified local fixes, and unverified platform capabilities.
- Real SDK tests verify supported ingress/queue continuation, concurrent scopes,
  active-span logs, and error correlation without altering customer identities.
- Remediation and remaining acceptance checks are dependency ordered; native
  bridging and v11 migration are not claimed as completed.
- Validation and independent implementation review are recorded in the audit
  report before handoff. No production changes are made by this audit.
