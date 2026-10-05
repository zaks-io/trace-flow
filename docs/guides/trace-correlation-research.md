# Trace correlation: external research

Researched: 2026-10-04. Applies to the
[code-review plan](trace-correlation-review-plan.md), whose source baseline is
`257b3285682f59c9015187d6558da4168469c0b4`.

This research was added after the Opus 5.5 reviews. It has not received an
independent review. It changes audit questions and verification requirements;
it does not authorize an SDK upgrade or application changes.

## Findings that affect the audit

### Native Cloudflare tracing does not currently offer a documented ID bridge

Cloudflare's current [custom spans reference][cf-custom] exposes
`tracing.getActiveSpan()` and span attributes/exception recording, but explicitly
lists **no `spanContext()` (trace/span IDs)** and **no manual parent-child wiring**.
The [known limitations][cf-limitations] page also says native trace context is not
propagated to services outside Cloudflare. The custom API page was updated
September 25, 2026; the limitations page was updated June 16, so verify the actual
deployed runtime before treating every older limitation as permanent.

Sentry's [Cloudflare drain guide][sentry-drain] and Cloudflare's
[Sentry export guide][cf-export] establish a supported OTLP export path. They do
not establish that the SDK and runtime use the same active context. Sending both
pipelines to the same Sentry project is not evidence of shared trace identity.

The audit must first test whether any supported bridge has shipped in the deployed
runtime. If not, evaluate annotating the native invocation span with the active
SDK trace ID and a delivery/request key, using `setAttributes`, as a searchable
mapping. This is a candidate proof, not a tested fix. Native IDs need not be
readable in application code to annotate a native span with a known SDK ID.
Confirm attribute export, queryability, context isolation, and sampling behavior.
Keep native and SDK IDs distinct; never claim that an attribute makes them equal.

### Sentry v11 changes integration choices, but does not prove a native bridge

The public npm registry reports `@sentry/cloudflare`, `@sentry/core`, and
`@sentry/nextjs` latest **11.4.0**, published October 2, 2026. The `v10` dist tag is
**10.76.0**. This repository resolves **10.73.0**. Consult the
[v11 migration guide][sentry-migration] and [own-OTel setup guide][sentry-otel]:

| Change                                                                                               | Consequence for this application                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry no longer registers an OTel provider by default; Next.js and SvelteKit are exceptions.        | Choose who owns application spans. `enableOpenTelemetrySetup: true` captures spans created through `@opentelemetry/api`; it is not a general OTLP exporter or proof of access to native Cloudflare spans.                                                                                                                                            |
| `openTelemetryIntegration()` associates errors/logs/metrics/crons with an existing active OTel span. | With an application-owned OTel pipeline, initialize it first, disable Sentry OTel setup, and leave both `tracesSampleRate` and `tracesSampler` unset. The docs warn that running both tracing pipelines creates duplicate spans that never join. Verify whether a native runtime span is visible to this integration before considering it a bridge. |
| RPC propagation uses `rpcTracePropagationBindings`; `enableRpcTracePropagation` is removed.          | Use an explicit caller binding allowlist. Wrapped v11 receivers automatically inspect/strip incoming metadata. Named entrypoints and DO classes still require instrumentation.                                                                                                                                                                       |
| Span streaming is the default.                                                                       | Verify emitted spans with a real SDK transport. `beforeSendTransaction` and `ignoreTransactions` do not apply in stream mode. Scope tags/extra remain on errors but do not reach streamed spans; use attributes for searchable span/log correlation.                                                                                                 |
| `sendDefaultPii` becomes `dataCollection`, with broader default collection.                          | Explicitly preserve restrictive collection of bodies, headers, cookies, GenAI inputs/outputs and query data. Review integration overrides and scrubbing; a rename alone does not preserve the old privacy boundary.                                                                                                                                  |
| One client is reused per isolate; Dedupe compares errors across requests.                            | Decide whether every repeated occurrence must be captured. Error-event counts can change independently of trace continuity.                                                                                                                                                                                                                          |
| `honoIntegration` is removed in favor of `@sentry/hono` middleware.                                  | Check actual Hono integration usage, automatic capture and duplicate reporting before any migration. This is a migration checklist item, not a claim that the repository currently calls the removed API.                                                                                                                                            |
| `nodejs_compat` is required.                                                                         | Current Worker configurations already set this flag. Older compatibility dates and `no_nodejs_compat_v2` still need real-runtime verification; do not assume the flag alone proves compatibility.                                                                                                                                                    |

The vendor recommends updating to the latest v10 before moving to v11.
An upgrade should be a separate proposal after the current correlation audit.

### Published SDK source clarifies two version-sensitive points

Read-only inspection of the published npm packages for **10.73.0** and **11.4.0**
confirmed:

- The RPC binding allowlist already exists in 10.73.0. In
  `utils/rpcPropagation.js`, a supplied list takes precedence over the old boolean;
  an empty list propagates to no bindings. Its types specify that v10 receivers
  still need `enableRpcTracePropagation: true`. In v11 the boolean is gone and an
  absent/empty list propagates to no RPC bindings. Use version-specific receiver
  rules rather than mixing current documentation with pinned behavior.
- The v10 `request.js` and v11 `wrapRequestHandlerWithInit.js` HTTP wrappers pass
  **`sentry-trace` and `baggage`**, not `traceparent`, to `continueTrace`.
  Neither inspected wrapper automatically resolves our W3C-only ingress mismatch.
  This statement is about those wrappers, not every Sentry SDK or OTel propagator.

Published package references:
[`@sentry/cloudflare@10.73.0`](https://www.npmjs.com/package/@sentry/cloudflare/v/10.73.0),
[`@sentry/cloudflare@11.4.0`](https://www.npmjs.com/package/@sentry/cloudflare/v/11.4.0).

### Practitioner reports closely match our concerns

These are public experience reports and maintainer responses, not verified defects
in Trace Flow. Check dates and resolution status before applying workarounds.

| Source                                                                  | Experience or recommendation                                                                                                                                                                                                                                                                       | Audit implication                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Have I Been Pwned: `stebet`][hibp]                                     | Reports successfully exporting to an HTTPS OTLP/HTTP collector; asks for active trace/span IDs and propagation into origin services.                                                                                                                                                               | Native export working does not establish end-to-end context propagation.                                                                                                                                                |
| [Clerk: `agis`][clerk]                                                  | Says access to the Worker trace ID and W3C `traceparent` propagation are important for their system.                                                                                                                                                                                               | The ID-access gap affects established production users too.                                                                                                                                                             |
| [Clerk sampling question and Cloudflare response][sampling]             | Asks to retain all error traces despite low head sampling; Cloudflare explains why distributed tail sampling is difficult.                                                                                                                                                                         | Missing parent spans may be sampling gaps. Test error identity separately from whether all parent spans were exported.                                                                                                  |
| [Cloudflare + Inngest correlation issue #15296][custom-ids]             | A user tried replacing an active span's private trace ID with a workflow-derived ID. Maintainers recommend immutable trace identity, workflow IDs as attributes, context continuation before starting spans, and span links when context arrives later. The user closed the issue accepting links. | Do not rewrite active trace IDs or use workflow IDs as operational identity. Load durable context before creating producer-specific consumer spans; link earlier work. The 2025 pseudocode is not a current API recipe. |
| [Duplicate propagation issue #19158][duplicate-headers]                 | Node/Next.js senders duplicated manually supplied and auto-injected headers; Cloudflare receivers could not parse the resulting context. A maintainer confirmed instrumentation overlap. Fixed in **10.47.0**.                                                                                     | Our 10.73.0 includes that fix; do not prescribe the historical workaround. Still test copied headers plus automatic injection, especially browser/server/Worker handoffs.                                               |
| [`otel-cf-workers` maintainer guidance][otel-cf]                        | Says maintenance has lagged and recommends trying native Workers tracing first, now that custom spans and export exist.                                                                                                                                                                            | Avoid introducing another instrumentation package without a demonstrated requirement and maintenance assessment. This does not remove the documented native ID-access limitation.                                       |
| [Uncaught exceptions missing from native OTLP export][exception-export] | A user supplied a repro where console logs exported but sync throws and `waitUntil` rejections did not. A Cloudflare maintainer reported a fix being rolled out.                                                                                                                                   | Revalidate caught errors, uncaught throws and background rejections separately in dev; do not equate exported console logs with complete error capture.                                                                 |
| [Native log/span correlation rollout][log-correlation]                  | A user saw different local/hosted behavior; a maintainer distinguished OTLP export from dashboard rollout.                                                                                                                                                                                         | Real hosted-runtime evidence is necessary. Distinguish dashboard behavior, exported logs and direct application log ingestion.                                                                                          |

The broader [Workers tracing discussion][cf-discussion] contains further feedback
on DO RPC durations, streaming responses, `waitUntil`, binding coverage, and the
new September 2026 custom span APIs. It is a useful place to monitor feature
availability; no comments were posted during this research.

### Messaging guidance supports links and persisted context

The [OpenTelemetry messaging span conventions][otel-messaging] explain creation
context, producer/consumer links, and batch processing. A span has one parent,
but a batch can contain messages from unrelated producer traces. Links represent
those relationships without assigning the entire batch to the first message.
Single-message processing can use producer context as its parent under the chosen
instrumentation policy. These messaging conventions are still marked Development;
use them as design guidance and record the selected semantics explicitly.

For this repository, review `sentry_trace_context` through durable envelopes,
encryption, retries, recovery and replay. Preserve the existing reference validation
and idempotency contracts. Restore context after loading/decryption, then create
the producer-specific processing span. Use links for pre-context work and mixed
producer flushes, subject to SDK/backend limits verified during the audit.

## Recommended audit order

1. Prove the native/SDK relationship and any supported bridge in the deployed
   runtime. If no bridge exists, prove an explicit searchable mapping.
2. Define operational trace fields separately from customer/domain/delivery IDs.
   Verify ingress precedence and both automatic and copied outgoing headers.
3. Restore durable producer context before producer-specific spans; test RPC
   callers/receivers using the current SDK's rules. Check batches, alarms and replay.
4. Prove that errors and logs refer to the expected active span, including caught
   failures, background rejections, concurrency and sampling gaps.
5. Assess v11 independently, including OTel ownership, streamed span attributes,
   privacy defaults, error deduplication and runtime compatibility.

Research used browser search, vendor documentation, public GitHub issues/discussions,
and published npm SDK source. Search summaries were used to locate primary sources,
not as evidence. No SDK upgrade, application edit, deployment, or external comment
was performed.

[cf-custom]: https://developers.cloudflare.com/workers/observability/traces/custom-spans/
[cf-limitations]: https://developers.cloudflare.com/workers/observability/traces/known-limitations/
[cf-export]: https://developers.cloudflare.com/observability/export/opentelemetry/sentry/
[sentry-drain]: https://docs.sentry.io/product/drains/cloudflare/
[sentry-migration]: https://docs.sentry.io/platforms/javascript/guides/cloudflare/migration/v10-to-v11/
[sentry-otel]: https://docs.sentry.io/platforms/javascript/guides/cloudflare/opentelemetry/custom-setup/
[cf-discussion]: https://github.com/cloudflare/workers-sdk/discussions/11062
[hibp]: https://github.com/cloudflare/workers-sdk/discussions/11062#discussioncomment-14901214
[clerk]: https://github.com/cloudflare/workers-sdk/discussions/11062#discussioncomment-15145978
[sampling]: https://github.com/cloudflare/workers-sdk/discussions/11062#discussioncomment-15149433
[custom-ids]: https://github.com/getsentry/sentry-javascript/issues/15296
[duplicate-headers]: https://github.com/getsentry/sentry-javascript/issues/19158
[otel-cf]: https://github.com/evanderkoogh/otel-cf-workers
[exception-export]: https://github.com/cloudflare/workers-sdk/discussions/11062#discussioncomment-17899025
[log-correlation]: https://github.com/cloudflare/workers-sdk/discussions/11062#discussioncomment-18083520
[otel-messaging]: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
