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

## Server-side cost estimates

Proxy Consumer prices imported v2 executions from `MODEL_PRICING` using `@trace-flow/pricing`. These are estimated API-equivalent costs, not invoice spend. Imports cannot submit `gen_ai.cost.*` or `trace_flow.cost.*`; generic OTLP cannot forge the server's cost stamps either. Agent Message facts and Agent usage totals remain in their separate datasets.

Only the reported `gen_ai.response.model` and `cliproxyapi.response.service_tier` select rates. The requested model, alias, and service tier remain source metadata. An absent reported model or tier stays unpriced, even when the requested alias happens to match a catalog entry. Exact catalog keys are preferred; dated model names can use the existing date-stripped family key. Imported pricing never fetches a substitute catalog from OpenRouter.

Reported `default` and `standard` select the base rates. `flex`, `priority`, and `batch` require explicit `serviceTiers` rate sets on the same central pricing record. Each set includes an HTTPS `referenceUrl` for the provider's pricing documentation and can have its own `contextTier`. Unknown tiers and missing rate sets are unpriced. There are no inferred discount multipliers. Upserts preserve the documented tier sets when `serviceTiers` is omitted. Supplying `serviceTiers` replaces them; an explicit empty object clears them. The admin editor UI is outside this slice.

Input context is uncached input plus cache reads plus cache writes. At or above the selected record's `contextTier.thresholdTokens`, that record's context rates replace its base rates. Missing context cache rates stay unresolved; they do not inherit the base cache rate. If unclassified tokens could move an execution across the context threshold, its estimate is unpriced. Cache writes with no reported TTL are excluded when the catalog's 5-minute and 1-hour rates differ.

Canonical input, cache read, cache write, non-reasoning output, and reasoning buckets are priced once each. Reasoning is part of output and uses an explicit reasoning rate when configured, otherwise the selected output rate. The output total is never charged again. Missing positive cache rates exclude those tokens from pricing coverage; explicit zero rates price their tokens at zero. Unclassified tokens do not contribute to the estimate. A missing usage block produces no cost, while a reported all-zero block can be priced at zero.

Catalog rates are microdollars per million tokens. A component costs `round(tokens * rate / 1000000)` microdollars; existing `gen_ai.cost.*` attributes serialize those results as USD. Server provenance is:

| Attribute                         | Meaning                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `trace_flow.cost.status`          | `priced`, `partial`, or `unpriced`                                    |
| `trace_flow.cost.reasons`         | Sorted unresolved-model, token, rate, tier, or TTL reasons            |
| `trace_flow.cost.method`          | `imported_catalog/2`                                                  |
| `trace_flow.cost.unit`            | `USD`                                                                 |
| `trace_flow.cost.catalog_key`     | The exact central catalog key that matched, when found                |
| `trace_flow.cost.catalog_version` | Catalog source and update timestamp, when found                       |
| `trace_flow.cost.rates`           | Applied rates, tier, threshold, and tier documentation, when priced   |
| `trace_flow.cost.priced_tokens`   | Tokens with known rates, including tokens priced at a configured zero |

Usage summary exposes `cost_priced_count`, `cost_partial_count`, `cost_unpriced_count`, `cost_priced_tokens`, `cost_proxy_count`, `cost_unassessed_count`, and `cost_coverage_ratio`. The ratio is unknown when old or edge-proxy rows lack imported coverage stamps, or when no tokens were reported. It counts reasoning once in the denominator. The existing Usage card shows estimate coverage, preserves a legitimate zero, and shows `-` for an entirely unpriced import range. Cache component money and derived savings are withheld when the range contains incomplete pricing. Period cost comparisons require complete coverage in both periods.

Historical rollups do not retain source identity. Buckets ending before October 1, 2026 UTC predate imported ingestion and retain proxy classification. Later migrated buckets without source-aware counts are shown as Not Assessed. Their recorded monetary values are preserved without repricing. New imports without a cost stamp are also Not Assessed; zero cost is unknown unless the range includes an assessed estimate or a proxy request.

The durable imported ledger compares source identity and source hash, excluding catalog enrichment. Separate POST retries, consumer restarts, DLQ replay, and catalog changes retain the first accepted estimate and provenance. A changed source record remains a visible conflict. This feature does not reprice historical facts.

### Pricing fixtures and development acceptance

[The pricing fixture](../../fixtures/imported-execution-pricing.json) records GPT-6.1 Sol standard, flex, batch, and priority rates checked on 2026-10-02 against [OpenAI pricing](https://developers.openai.com/api/docs/pricing). OpenAI calls priority processing Fast mode in its current documentation; the fixture supplies its documented prices explicitly under the imported `priority` label. The 272,000-token inclusive context threshold follows the central [models.dev catalog](https://models.dev/api.json). Tests exercise both sides of that threshold through the imported pricing module, preserving the existing central threshold convention.

Before cloud-dev acceptance, deploy the additive Tinybird migration and dev consumer, and configure the documented central rates in the dev catalog. Use dev API-key and Tinybird credentials; do not use Collector Credentials to upload proxy executions. Upload new execution UUIDs using the v2 contract with the fixture's actual model and reported tiers, then read back raw span provenance and Usage under the authenticated key. Independently verify component costs, count/status coverage, and USD units. For uncached/read/write/non-reasoning/reasoning counts of 1000/200/100/300/50, flex and batch total USD 0.002885; priority totals USD 0.01154.

Repeat each POST after changing a dev catalog rate and after restarting the dev consumer. Counts, costs, and stored provenance must stay unchanged. Upload an overlapping Collector observation using a valid dev Collector Credential and verify its Agent Message and Agent usage outputs separately; proxy replay must not change them. No combined total or cross-source join is created. A failed dev authentication probe is a verification blocker, not a successful reconciliation.
