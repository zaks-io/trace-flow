# Trace Flow production performance investigation

Investigated 2026-10-06 UTC against commit `bcd3151`. Scope covers the Trace Flow ingest,
web, and proxy findings in the supplied Grafana Application performance screenshots.

The ingest alert is primarily snapshot backpressure. A stuck recovery caused most of the
failures, and ordinary snapshots still block new uploads for about three minutes. The proxy
also has a confirmed billing-period regression that adds synchronous work and loses usage
counts. Web needs CPU profiling and clearer separation of response time from background work.

## Evidence

Production reads used Axiom's `cloudflare` dataset, Sentry, Cloudflare deployment metadata and
GraphQL invocation metrics, and GitHub deployment results. Public HTTP probes and the T3
collaborative browser exercised the homepage. An Opus 5.5 agent independently inspected the
ingestion code. No production writes or deployments were performed.

Most comparisons use 2026-10-05 04:16 through 2026-10-06 04:16 UTC. Some follow-up aggregates
use the subsequent rolling hour or day and are identified below. Counts from separate
telemetry paths differ slightly. The exact Grafana query and recording rules were not read.

| Finding             | Measured evidence                                                                                                                                                                          | Implication                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Ingest failures     | 289 HTTP 503 responses, 90 HTTP 202 responses, and 481 health checks in Axiom invocation logs                                                                                              | About 76% of upload attempts failed in this window. Health checks dilute the screenshot's 33.7% rate.                    |
| Failure cause       | 288 `agent_ingest.delivery_admission_closed` warnings for one organization; one `delivery_publish_failed` internal platform error                                                          | The main failure is admission backpressure. There were no observed 429s or validation failures in this window.           |
| Stuck recovery      | Sentry [TRACE-FLOW-30](https://zaksio.sentry.io/issues/TRACE-FLOW-30) exhausted receipt discovery for generation 1025 at 20:58 UTC. There were 269 HTTP 503s from 20:58 through 01:05 UTC. | Most failures occurred during one prolonged recovery incident.                                                           |
| Recovery improved   | After the 01:05 deployment, 45 uploads returned 202 and 6 returned 503 through 04:16 UTC                                                                                                   | The newer code substantially reduced failures, but ordinary gate closures remain.                                        |
| Normal snapshots    | Across 50 publications in a rolling day, 41 captured one day. Those had a median gate duration of 187 seconds and p95 of 243 seconds.                                                      | Even small incremental uploads encounter lengthy pauses.                                                                 |
| Copy polling        | All 459 logged Copy checks in a follow-up rolling day reported `done`, `statusChecks: 1`, and no recovery                                                                                  | Every observed Copy had completed before its first status check. The current schedule waits longer than these jobs need. |
| Delivery processing | Sentry counted 190 `process agent-delivery` spans with median 1.321 seconds and p95 2.729 seconds                                                                                          | Processing is substantially shorter than the normal snapshot pause.                                                      |
| Identity lookups    | Sentry [TRACE-FLOW-2Y](https://zaksio.sentry.io/issues/TRACE-FLOW-2Y) flags repeated identity queries. There were 339 lookup spans with median 192 ms and p95 448 ms.                      | This is a secondary source of time spent holding the organization's write permit.                                        |

The screenshot reports 857 total requests. The nearby Axiom window contains 860. The same
289 failures are present; the three-request denominator difference remains unverified.

Cloudflare's GraphQL schema explicitly reports these time fields in microseconds. Converted
to milliseconds, successful Worker invocations in the fixed comparison window showed:

| Worker         | CPU p50 |  CPU p95 | Wall time p95 |
| -------------- | ------: | -------: | ------------: |
| Agent ingest   |  6.9 ms |  76.3 ms |      1,619 ms |
| Agent consumer |  9.8 ms |  37.6 ms |      2,305 ms |
| Proxy          | 12.4 ms |  19.9 ms |      1,339 ms |
| Web            |  565 ms | 1,274 ms |      2,408 ms |

Ingest invocations had zero runtime errors in this aggregate, although the application returned
HTTP 503. Raising the CPU limit would not address the observed rejection cause. These metrics
mix routes and include Worker lifecycle work; they are not equivalent to browser TTFB.

### What is already deployed

Deployment [37396823425](https://github.com/zaks-io/trace-flow/actions/runs/37396823425) completed
at 01:05 UTC for `f8c6f53`, which prevents stranded snapshot Copy intents. The subsequent
[37404660299](https://github.com/zaks-io/trace-flow/actions/runs/37404660299) completed at
02:39 UTC for `bcd3151`, which improves snapshot error diagnostics. Cloudflare reports the
current consumer version as `cc476910-a8da-4970-a601-8d046efe99ea` and ingest version as
`af16d52d-388d-4868-8431-684fda5474aa`; recent production telemetry uses those versions.

Earlier `3327c73` preserves staged deliveries during admission races and adds Collector
`Retry-After` handling. The next changes should build on these fixes rather than repeat them.

## Causes in the code

### Ingestion blocks acceptance while snapshots run

[ADR 0024](../adr/0024-bounded-agent-ingestion.md) requires stable canonical input throughout
the nine serial snapshot Copies. The coordinator closes its gate while draining and copying.
[The ingest handler](../../apps/agent-ingest/src/handler.ts) converts closed admission to HTTP
503 with a 60-second retry delay.

[Snapshot checks](../../apps/agent-consumer/src/snapshot-checks.ts) start 15 seconds after each
Copy. Nine serial Copies therefore impose roughly 135 seconds of scheduled waiting before
network and queue overhead. The measured gate duration is about 185 to 243 seconds for
ordinary generations. Keep the canonical write fence while reducing this delay.

[Staging](../../packages/utils/src/agent-delivery.ts) assigns a random object key on every
attempt. If a request stages data and then receives a retryable failure, the preserved delivery
can recover while the Collector retries into a second delivery. This amplification is a
code-derived risk; its production frequency was not measured. Exact fact replacement protects
canonical identities, but additional deliveries still consume capacity and processing time.

The consumer serializes writes per organization and caps active references at 64. Its identity
lookup uses GET requests with 32 identities per chunk, six connections at a time, and serial
category loops in [delivery-partitions.ts](../../apps/agent-consumer/src/delivery-partitions.ts).
Bounded buffering and efficient lookup matter more than increasing global queue concurrency.

### Proxy billing configuration repeatedly moves backward

In [usage-tracker.ts](../../apps/proxy/src/usage-tracker.ts), `configChanged` considers a
different upstream billing-period start to be a change. `updateConfig` accepts that period
even when it is older than the locally advanced period. `handleFetch` resets subscription
counters when the start changes, then `handlePeriodRollover` synchronously pushes to Convex
and resets again when the supplied period has already expired.

The next request repeats the cycle if the upstream subscription configuration is still stale.
A rolling-hour log query showed 1,269 synchronizations for one expired billing period, all
with subscription usage zero. The period ended on 2026-04-27. The upstream reason for that
stale value was not established.

A production trace for `/v1/traces` took 980 ms at the Worker level. Its usage check consumed
512 ms and included `/usage/record`. A rolling-hour aggregate also showed 1,180 usage-record
fetches for 1,145 usage-check fetches, inconsistent with occasional alarm-only synchronization.

A temporary test drove the actual `USAGE_TRACKER` Durable Object under workerd with three
one-unit checks carrying the same expired upstream period. All were allowed. Two synchronous
updates reported usage 1 and 0, and the alarm then reported current usage 1. The assertion
that three accepted units remain counted failed with `expected 1 to be 3`. The diagnostic
test was removed after reproduction; product code was unchanged at that investigation checkpoint.

The existing broad usage-tracker tests reproduce older logic in a mock implementation.
The fix needs regression coverage against the actual Durable Object.

### Web timing needs attribution

Native server spans showed homepage GET p95 around 3.83 seconds in the fixed window.
HEAD requests accounted for 1,921 of the measured web server spans. A single public browser
navigation measured TTFB 99 ms and first contentful paint 464 ms, while two sandbox HTTP GETs
measured TTFB 1.49 and 2.74 seconds. These samples demonstrate variation, not a production SLO.

One 3.725-second homepage trace logged `web.request_complete` after approximately 628 ms,
then contained Axiom and Sentry exports before the native invocation ended. The application
log reported `latencyMs: 0`. Cloudflare documents that `Date.now()` and `performance.now()`
advance only after I/O, so neither can accurately profile synchronous rendering in production.
Changing one timer API to the other will not fix this measurement.

The homepage currently performs session work and uses middleware with a per-request CSP
nonce. Static caching must preserve authentication redirects and nonce correctness. Public
layout also includes a Convex provider. Their CPU contributions have not been profiled.

Browser inspection additionally reproduced a Next.js prefetch of `/auth/login` that followed
an Auth0 redirect and failed CORS before any click. The corresponding `Link` elements use
default prefetch behavior in `HeroSection.tsx` and `SignupButton.tsx`.

## Recommended implementation order

### 1. Fix the proxy billing-period regression

Treat billing periods as ordered, authoritative state. Reject or ignore an older period without
discarding valid tier or addon changes. Persist any required completed-period synchronization
before a reset and retain it until confirmed. Ordinary checks must use locally durable counters
and avoid rollover synchronization on every request.

Trace the expired period through the Convex subscription and KV synchronization path, then
repair its source through the normal billing operation after the behavior is fixed. Historical
count discrepancies require an evidence-based reconciliation plan; the investigation does not
establish the lost production total.

Add real workerd tests for repeated stale configuration, genuine forward rollover, addon
updates, concurrent checks, process restart, and a failed final-period push. Preserve exact
accounting and revocation behavior before optimizing latency. This is the first fix because it
affects correctness as well as performance.

### 2. Shorten snapshot gate closure

Measure actual Copy completion time and separate Copy execution, alarm delay, queue delay,
and RPC time. Tune the first status check to the measured job duration for ordinary batches.
A five-second first check is a starting experiment, not a predetermined production setting.
Retain durable intents, bounded status/discovery budgets, the two-generation global admission
limit, serial Copy execution, and the canonical write fence.

Benchmark one-day, seven-day, and large linked-correction generations on an isolated Tinybird
branch. Compare gate duration and Jobs API call count. A proposed ordinary-generation target
is p95 below 120 seconds, with no more than two status reads per Copy in the ordinary fixture.
Use a longer cadence for genuinely long jobs if measurements require it. Update ADR 0024's
polling contract with the verified setting. Increasing debounce indefinitely would trade upload
availability for stale dashboards, so retain a bounded freshness target.

### 3. Make retries reuse a durable receipt, then consider bounded acceptance during snapshots

First make retries idempotent across staging, admission races, partial groups, and uncertain
queue sends. Scope the identity to organization, Collector, and batch. Store a content digest
separately and fail on conflicting reuse. Exclude attempt timestamps and trace context from
the retry identity. Preserve the first object's immutable encryption metadata and original
expiry. An existing conditional R2 write must load and verify the original receipt rather than
overwrite it or renew its retention.

Measure duplicate deliveries before and after. Verify retries create one set of transport
deliveries and one ordered canonical result even when the response is lost.

If shorter snapshots still cause material rejections, separate durable upload acceptance from
permission to write canonical facts. Accept a bounded number and byte volume of pending
deliveries while keeping snapshot input frozen. Use a durable cutoff so the snapshot drains
only prior accepted work and later uploads cannot prevent it from starting. Recover those
pending references after restart, fence them during erasure, and include their expiry in the
existing incomplete-day rules. This is a larger ADR change and should follow the smaller fixes.

Do not remove the write gate or raise the 64-reference cap to conceal the bottleneck. Saturation
and provider failures should remain visible, with a specific reason and a useful retry delay.

### 4. Profile and fix web CPU, plus the known prefetch issue

Disable route prefetch for login entrypoints or use ordinary navigation links. Verify no
authorization request occurs before a click and sign-in still works with keyboard navigation.

Profile the production-equivalent OpenNext Worker locally. Separate module initialization,
middleware/session work, rendering, response streaming, and telemetry export. Correlate Worker
CPU with route, method, deployment, and warm/cold requests. Add response-facing browser and
external probe measurements alongside invocation duration; separate health checks, internal
DO requests, and background tasks in the dashboard.

Then optimize the measured dominant path. Prefer prerendered or cached anonymous public
content if profiling supports it, while preserving CSP and authenticated redirects. Avoid
loading public-page providers that have no consumer. Evaluate overlapping native, Next.js,
and Worker instrumentation if it dominates CPU, retaining required correlation and errors.
Compare at least 30 repeated reads across warm/cold conditions and two vantage points before
claiming a latency improvement.

### 5. Optimize delivery lookups and ingest hops if they remain material

Benchmark the identity lookup against its existing two-million-row retained-history fixture.
Consider larger bounded POST batches and a global six-connection budget across categories,
with tenant and retention filters intact. Prove correction tombstones and legacy ordering before
changing lookup behavior. Remove redundant admission round trips only when the authoritative
registration check and race recovery remain intact.

Profile repeated validation, encoding, and hashing at 256 KiB, 2 MiB, and the 10 MiB limit.
The measured ingest CPU is low, so those changes follow the service-level causes above.
Validation and redaction must remain at the actual trust boundaries.

## Done

- The proxy counts every accepted unit once across stale configuration, rollover, retry, and
  restart. Workerd regression tests pass, and a dev flow confirms normal requests do not push
  completed-period usage synchronously on every call.
- Ordinary snapshots meet the agreed gate-duration target and retain bounded Jobs API traffic.
  Unknown Copy outcomes still require safe recovery; every published generation has complete
  targets and exact canonical-fact parity.
- Retried uploads reuse their original durable acceptance. The dev Collector flow proves no
  duplicate transport work or loss after response failure, admission races, partial batches,
  queue failure, and restart. Saturation stays bounded and returns explicit backpressure.
- Web's measured CPU and response-facing latency improve against a recorded baseline. Login
  prefetch no longer initiates OAuth, and auth redirects, CSP, browser interactions, and narrow
  and wide layouts remain correct.
- Production dashboards show upload-only failure rates, gate age, recovery-required state,
  freshness, and response-facing latency alongside background duration. Alerting continues to
  expose sustained upload rejection.
- Each implementation change passes its affected tests, types/lint, formatting, local review,
  and repository CI gates. Dev end-to-end checks precede a separately approved production
  deployment and follow-up read-only comparisons.

## Implementation and local evidence

Tracked in [TRA-344](https://linear.app/zaks-io/issue/TRA-344/fix-stale-usage-periods-and-reduce-ingestion-and-web-overhead).
The implementation includes the confirmed application fixes. Production rollout and the host
Grafana changes remain separate approval steps.

- Usage checks keep ordered periods and atomic local counters. Completed totals enter a durable,
  bounded SQLite outbox before reset; Convex calls run only from alarms. Confirmation records
  the exact submitted totals, and Convex preserves maximum totals per period. Authentication,
  throttling, and server failures retain snapshots for the minute alarm. Terminal HTTP rejections
  are logged and retired as in the prior implementation. A full outbox can drain, legacy counters
  survive upgrade, and authoritative current periods can replace a local estimate without resetting
  consumed units when the corrected start falls after the preceding estimated interval's start.
  Older starts, including late extensions of the preceding real period, retain the existing
  behavior of ignoring backward changes. Reopening them would require reconciling prior usage,
  including snapshots already confirmed and removed locally. Runtime regressions preserve both
  periods' totals for pending and confirmed snapshots across eviction. Period-end corrections
  are synchronized too.
- Snapshot checks run at 5, 15, 45, and 105 seconds, then every 60 seconds. The workerd fixtures
  reduce fast-Copy polling wait from 135 to 45 seconds for one-day and seven-day generations,
  with nine status reads in both cases. A 32-date correction falls from 270 to 90 seconds with
  18 reads. Seven-second Copies still wait 135 seconds and require 18 reads instead of nine.
  Serial Copies, global capacity, persisted checkpoints, and recovery budgets remain enforced.
  The 15-read bound is retained; adding the early read exhausts the long-job horizon one minute
  earlier. That tradeoff limits API load and is recorded for the isolated provider benchmark.
- Ingest retries use an org/Collector/batch/content identity and reuse the original encrypted
  object or durable receipt. A small conditional request manifest rejects conflicting batch
  reuse before ownership claims. Attempt timestamps and trace context do not change chunk
  boundaries or identity. Completed receipts do not renew transport retention. Runtime tests
  cover conditional R2 writes, uncertain sends, partial groups, completed-body deletion,
  concurrent retries, ownership changes, and erasure fences.
- Identity lookups share a six-request budget across categories, retaining the existing
  32-identity GET limit and tenant/time filters. A deterministic six-category fixture with
  100 ms reads falls from six waves at 600 ms to two waves at 200 ms, with the same 12 reads.
  This is a scheduling measurement. The retained-history Tinybird benchmark remains a rollout
  check; no pipe, schema, retention, or lookup batch-size change is included.
- Login entrypoints use ordinary anchors. The alpha homepage loads neither Convex nor waitlist
  code; waitlist mode and public invite/waitlist routes retain their providers. This follows
  the pinned Next.js guidance for
  [conditional dynamic imports](https://nextjs.org/docs/app/guides/lazy-loading).

The local production-equivalent OpenNext Worker baseline and final build each served 30 warm
homepage GETs. Baseline TTFB p50/p95 was 24.3/29.5 ms; the final build measured 17.2/24.5 ms.
Total response p95 was 38.4 ms versus 32.2 ms. These are single-sandbox samples under variable
shared load, so they do not establish production CPU attribution or a production latency SLO.
CPU profiles are retained in the worktree's private runtime state. They do not isolate one
production hotspot well enough to justify changing telemetry or session/CSP handling.

Browser checks on the OpenNext preview verify no OAuth request before hover/focus/click,
no Convex connection on the alpha homepage, functional keyboard OAuth navigation,
and no horizontal overflow at 1280 and 390 CSS pixels. The loaded alpha script total is
268,442 encoded bytes. Waitlist mode was checked with an intercepted Convex connection,
including shared connection, disabled loading state, and recoverable error state. No external
mutation was sent by that check. Invite loading, invalid-state, and pending-invite OAuth navigation
checks pass with intercepted Convex reads and no external query sent.

Remaining rollout checks are actual Tinybird Copy timing and canonical parity on an isolated
branch, deployed dev Collector-to-consumer retries, production CPU and two-vantage-point latency
comparisons, live billing-source repair and historical reconciliation, and host-owned Grafana
queries/alerts. The Grafana request is retained as host-change receipt 1, submitted for operator
review without executing a change. The broader acceptance-during-snapshot design remains
conditional on those results.

The deployment workflow now requires the consumer to deploy successfully before the ingest
Worker that calls its receipt RPC. This dependency also applies when migration jobs are skipped.
Local CI accepts forwarded Turbo concurrency arguments and passes standard Vitest/Next worker
limits through strict environment filtering, so the required gate can run within sandbox limits.

The final full local gate passed all 64 Turbo tasks, including 449 passing proxy tests and one
pre-existing skipped test. Knip, Tinybird contracts, workflow lint, formatting, and a scoped staged
secret scan passed. The review preview remains at https://sbx-2.tail4068ec.ts.net:3001/.

## References and remaining limits

- [Cloudflare timing behavior](https://developers.cloudflare.com/workers/runtime-apis/performance/)
- [Cloudflare GraphQL Worker metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [Bounded ingestion ADR](../adr/0024-bounded-agent-ingestion.md)
- [Snapshot recovery runbook](./agent-conversation-analytics/runbook.md)

The initial investigation made no application changes. The subsequent implementation followed
Isaac's request to implement the plan. No authenticated upload or backfill was sent to production.
Actual Copy completion times, transport duplication frequency, web CPU stack
attribution, the stale billing-period source, and historical usage loss remain to be measured.
The Grafana dashboard is on the host, outside the sandbox's service grants; its exact query
and any dashboard changes require the authorized host workflow.
