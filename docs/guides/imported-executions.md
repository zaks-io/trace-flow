# CLIProxyAPI execution OTLP contract

CLIProxyAPI sends one metadata-only OTLP root span for each model execution to `POST /v1/traces` with `X-Trace-Flow-Api-Key`. The [v2 request fixture](../../fixtures/cliproxyapi-execution-v2.json) contains non-streamed, streamed, unclassified, inconsistent, missing-usage, and failed executions. It contains no prompts, responses, headers, raw account names, or failure bodies.

The instrumentation scope is `cliproxyapi.execution` at version `2`. A different version or a request mixing this scope with generic scopes gets HTTP 400. An export may contain several v2 execution spans. Each span uses kind `SERVER`, no parent, no events or links, and an empty status message. Its name is the requested model. `OK` means the execution did not fail; `ERROR` means it failed. A failure can still have reported usage.

`cliproxyapi.execution.id` is a globally unique UUID of one execution attempt. Remove its hyphens for the 32-character OTel `traceId`; use the final 16 hex characters for `spanId`. Keep these values unchanged on every retry, including after exporter restart. `cliproxyapi.request.id` is CLIProxyAPI's short inbound TraceID, when available. It is display metadata and can repeat across several execution attempts. `cliproxyapi.installation.id` is a stable UUID in resource attributes. Trace Flow combines the authenticated Organization, installation UUID, and execution UUID to identify an imported execution. The API key and inbound request ID are not part of that identity.

The other resource attributes allowed are `service.name` (required), `service.version`, `service.instance.id`, and `telemetry.sdk.name`, `.language`, and `.version`. The span allows requested and reported model, provider, model alias, requested and reported service tier, streaming flag, time to first token in milliseconds, HTTP failure status, source-visible session IDs, and account coverage. `cliproxyapi.account.coverage` is `provider-account`, `credential`, or `unknown`. The first two require a lowercase 64-character `cliproxyapi.account.ref` that the exporter derives as an HMAC of `coverage + "\0" + id` with a per-installation secret. Unknown coverage forbids the reference. Do not send raw email addresses, tokens, provider API keys, arbitrary headers, prompt or response text, or failure bodies in any field.

Usage follows CLIProxyAPI `TokenBreakdown` schema version 2. A present block sends `gen_ai.usage.schema_version=2`, quality (`complete`, `inconsistent`, or `unclassified`), and every count below. A missing block sends only `gen_ai.usage.missing=true`. Explicit zero is a known zero; absence is not zero.

| Count                | OTLP attribute                             |
| -------------------- | ------------------------------------------ |
| Total                | `gen_ai.usage.total_tokens`                |
| Input total          | `gen_ai.usage.input_tokens`                |
| Input uncached       | `gen_ai.usage.input_tokens_uncached`       |
| Input cache read     | `gen_ai.usage.cache_read_input_tokens`     |
| Input cache write    | `gen_ai.usage.cache_creation_input_tokens` |
| Output total         | `gen_ai.usage.output_tokens`               |
| Output non-reasoning | `gen_ai.usage.output_tokens_non_reasoning` |
| Output reasoning     | `gen_ai.usage.reasoning_tokens`            |
| Unclassified         | `gen_ai.usage.unclassified_tokens`         |

Input total equals uncached plus cache read plus cache write. Output total equals non-reasoning plus reasoning. Total equals input plus output plus unclassified. `complete` requires zero unclassified tokens. All counts are nonnegative, and total cannot exceed 4,294,967,295. The exporter should reject a `TokenBreakdown` that fails its own `Valid()` check before shipping it. An inconsistent breakdown carries the authoritative total in unclassified tokens rather than inventing input or output counts.

The exporter must omit `trace_flow.source` and every `trace_flow.import.*` attribute; Trace Flow adds these server stamps after validating the export. Generic OTLP continues to pass `gen_ai.usage.*` attributes through unchanged, but cannot claim an imported source or identity.

The v2 path rejects fields outside this contract, duplicate attributes or executions in one export, an OTel ID that does not match the execution UUID, malformed account references, mixed missing and present usage, timestamps outside the positive Int64 nanosecond storage range or with end before start, and durations over 24 hours. HTTP 400 responses use rule codes such as `attribute_not_allowed`, `usage_total_invariant`, and `otel_identity`; they do not echo submitted values. Authentication and recording-policy failures use the existing OTLP responses. The proxy stores the accepted delivery envelope in R2 before returning 200, then publishes a queue reference. Exact retries append no second span or request fact, even if arrival time, API key, retention tier, or later catalog enrichment changes. Changed source content for the same execution creates a blocked repair record and retains the original row.

For a development readback, send the fixture to the dev `/v1/traces` endpoint with a dev API key. Query Requests and Usage under that key. Expect five Requests, a failed request with seven reported tokens, one missing-usage request, and total tokens equal to input plus output plus unclassified for each reported block. Resend the same fixture as a new POST and after restarting the dev consumer; the counts must stay at five. Change one source token count while keeping an execution UUID and confirm that the Trace Shard exposes a repair while the original remains. Send two executions with one inbound request ID and confirm two Requests. Send the same installation and execution UUID through a second Organization's API key and confirm separate records. Collector Agent Message facts remain in their own datasets and do not join these proxy execution totals.
