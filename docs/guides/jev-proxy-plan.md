# Jev proxy support plan

Researched on October 5, 2026. Implemented locally; full CI validation and live dev verification remain outstanding. No live inference calls or deployments performed.

Support Jev's native request and response contracts through Trace Flow, with the same capture, trace correlation, usage accounting, and body inspection available for existing model APIs. Implement this as decision-protocol support shared by OpenRouter and TypeSafe, using the existing provider adapters and capture pipeline.

## Verified provider contracts

Jev is TypeSafe's structured decision model. Requests contain `model`, `state`, and a map of `questions`. Responses contain the resolved `model`, an `answers` map, and `usage.input_tokens` / `usage.output_tokens`.

The three question types are `choice`, `score`, and `noul`. Choice returns a selected option, probabilities, and confidence. Score returns a weighted score, a legend, probabilities, and confidence. Noul returns a yes/no probability. Requests can contain several questions. The documented endpoints return JSON; they do not document a streaming protocol.

| Trace Flow endpoint                | Upstream endpoint                           | Model examples                                |
| ---------------------------------- | ------------------------------------------- | --------------------------------------------- |
| `POST /typesafe/v1/systemone`      | `https://api.typesafe.ai/v1/systemone`      | `jev-latest`, `jev-1.13.0`                    |
| `POST /openrouter/v1/systemone`    | `https://openrouter.ai/api/v1/systemone`    | `jev-latest`, `jev-1.13`, `typesafe/jev-1.13` |
| `POST /openrouter/alpha/decisions` | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13`, `~typesafe/jev-latest`   |

Both providers authenticate with a bearer API key. OpenRouter's System One endpoint maps bare TypeSafe model names to its own namespace. Trace Flow should preserve the caller's model and let the upstream perform that mapping.

OpenRouter adds `id`, `provider`, and `usage.cost` in USD. Its schema makes these additional fields optional. Direct TypeSafe documents token counts but no billed-cost field. Both currently advertise **$0.042 per million input tokens and free output tokens**. Nonzero output token counts must still be recorded.

TypeSafe documents a 64k total request budget and a 32k budget for state plus the longest question. OpenRouter advertises a 32k context window. Preserve the upstream validation behavior rather than imposing one shared limit.

`typesafe/jev-router` is a separate product that selects a generative model. This plan covers Jev decisions. It does not change chat routing or add automatic routing through Jev Router.

Sources:

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [TypeSafe models, prices, aliases, and limits](https://docs.typesafe.ai/models)
- [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev)
- [OpenRouter Decisions API schema](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
- [TypeSafe SDK through OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk)
- [Live Jev pricing and provider metadata](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)
- [Live decision-model catalog](https://openrouter.ai/api/v1/models?output_modalities=decisions)
- [OpenRouter model-list parameters](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)

## Existing behavior and gaps

- `packages/llm-providers/src/routing.ts` already forwards both OpenRouter path suffixes. TypeSafe needs registration in the provider registry and the URL-to-provider mapping in `packages/utils/src/providers.ts`.
- `deriveOperationName` currently classifies these endpoints as chat. The consumer classifies non-embedding JSON responses as text. Both need a decision classification.
- The OpenRouter token schema already recognizes input/output tokens and upstream cost. Whole-body extraction uses regexes, which are unsafe for decision maps whose customer-controlled keys can resemble accounting fields.
- `apps/proxy/src/queue.ts` currently takes the request model from response metadata. Jev aliases and error attribution require separate requested and resolved model values.
- The consumer pricing fetch and both Convex OpenRouter import paths request `/api/v1/models` without an output filter. That endpoint defaults to text models. A live check found Jev only after requesting `output_modalities=decisions`.
- The decision catalog supplies `canonical_slug` and `alias_target`. These identify `typesafe/jev-1.13-20260917` and `~typesafe/jev-latest`; loose suffix matching is insufficient. Direct TypeSafe returns a different version spelling, `jev-1.13.0`.
- Existing body viewers understand chat messages and completions. They need a decision view to make captured state, questions, and answers useful.

## Implementation sequence

### 1. Native endpoints and safe parsing

Register TypeSafe with upstream base URL `https://api.typesafe.ai`. Preserve the existing provider-prefixed proxy convention and credential handling. TypeSafe SDK callers can use a base URL ending in `/typesafe`; the SDK appends `/v1/systemone`. OpenRouter-backed SDK callers use a base URL ending in `/openrouter`.

Identify decision requests by provider and endpoint, with a shared custom operation name `decision`. Keep protocol selection independent of model names. Extend the existing provider parsing context narrowly so OpenRouter can select decision parsing without changing its Chat Completions or Responses handling.

Use one shared decision parser for the two real provider adapters. Parse the top-level JSON fields and the actual top-level usage object. Validate finite, nonnegative costs and nonnegative integer token counts. Preserve zero versus missing, and reject ambiguous or malformed accounting metadata without changing the upstream HTTP response.

Capture the requested model separately from the resolved model. Preserve provider request IDs when present. Keep state, instructions, option labels, question names, probabilities, and answers in the existing encrypted body storage. Only bounded structural summaries, such as question counts by type, belong in queue/span metadata. Do not fabricate chat messages or copy customer question keys into analytics dimensions.

Keep the existing capture size limits, body-omission policy, redaction, and durability gate. A truncated JSON capture must not yield guessed token totals. Preserve upstream HTTP errors and retry headers; do not add a proxy retry loop that could duplicate billable decisions.

Main files: `packages/llm-providers/src/{types,schemas,routing}.ts`, its `providers/` directory, `packages/utils/src/providers.ts`, `packages/types`, and `apps/proxy/src/{transaction,queue}.ts`.

### 2. Pricing and observability

Extend the existing OpenRouter catalog fetches to request `output_modalities=text,decisions`. Index documented model IDs, canonical slugs, and alias targets. Apply the same identity rules in the consumer fallback and Convex pricing imports. Validate catalog rates before caching them, including legitimate zero rates and invalid negative/sentinel rates.

Add a versioned direct TypeSafe entry to the existing default-pricing catalog, sourced from its own documentation. Price resolved versions and retain the requested alias for attribution. Do not use an unrelated provider's price or an old alias price for an unknown new version. Ensure the existing pricing refresh flow updates decision models; the consumer's one-year KV fallback cannot be the sole refresh mechanism.

Preserve the existing distinction between calculated `gen_ai.cost.total` and provider-reported `gen_ai.cost.upstream`. Direct TypeSafe cost is an estimate from published rates. OpenRouter's reported cost is recorded when present, including zero. Missing prices remain unknown. Reuse request counts, latency, HTTP status, token counts, provider/model grouping, and trace correlation.

Emit a decision result classification rather than an assistant-text result. Do not invent a finish reason, streaming TTFT, or generated-text throughput. If question counts are recorded, keep them separate from request counts so a batched request is counted and priced once.

There is a precision issue to resolve before claiming exact aggregate spend. The current estimator rounds each request to integer microdollars, and Tinybird usage facts/rollups also use integer microdollars. At Jev's rate, 476 input tokens cost $0.000019992; rounding produces $0.000020. The raw upstream span attribute already retains the reported value. Add a repeated-small-request test and include an additive fixed-precision cost path for decision estimates and reported amounts if exact dashboard totals are part of acceptance. Reuse current fields for compatibility, avoid destructive schema replacement, and validate the new aggregate against the raw amounts. If precision work is deferred, explicitly document the rounding limit rather than labeling aggregate spend exact.

Main files: `packages/pricing/src/openrouter.ts`, `packages/convex/billing/{modelPricing,defaultPricing,pricingSync}.ts`, `apps/proxy-consumer/src/{index,openrouter-pricing,spans}.ts`, and `packages/otel-conventions`. Cost-precision work also touches the relevant Tinybird facts, rollups, and queries; decision classification itself does not require new tables.

### 3. Trace inspection and integration documentation

Extend the existing trace detail panel with a decision request/result view. Show state and questions from authorized body retrieval, then each typed answer with its documented fields. Reuse current JSON viewers and visual treatments. A Noul probability must not be presented as a Choice confidence score. Missing or omitted bodies should retain the existing explicit unavailable state.

Show requested and resolved models, provider, latency, usage, estimated cost, and reported cost where available. Verify model/provider filters and usage summaries include the new requests. Update the public integration guide with curl and official TypeSafe SDK examples for both providers. Note that OpenRouter's model-list response is not compatible with the TypeSafe SDK's `models.list()` response type, as documented upstream; do not silently rewrite it.

Main files: `apps/web/src/components/traces/SpanDetailPanel.tsx`, related trace classification helpers, `packages/utils/src/message-parsing.ts`, and `apps/web/public/agents.md`.

### 4. Verification and rollout

Use provider-documentation fixtures first, then exercise the running proxy and consumer. Verify:

- All three paths preserve request payloads, provider authorization, status codes, response JSON, and relevant headers. Trace Flow credentials and internal tracing headers remain isolated from providers.
- Choice, Score, Noul, mixed-question batches, aliases, versioned models, zero usage/cost, missing usage/cost, malformed JSON, and truncated captures behave correctly.
- Customer keys named `model`, `usage`, `input_tokens`, or `cost` cannot override top-level accounting.
- Authentication errors, validation errors, rate limits, overload, and transport interruption retain request attribution without invented successful results.
- Each request produces one accounted decision with correct token totals and provider-specific pricing. Unknown versions remain unpriced. Output counts remain visible while output cost is zero.
- Catalog discovery includes Jev, canonical/alias mappings resolve correctly, and tiny-cost aggregation meets the documented precision contract.
- Encrypted capture, omission, durable envelope persistence before terminal EOF, consumer staging, and acknowledgment retain their existing guarantees.

Run focused provider, proxy, pricing, consumer, and affected UI checks, then the repository's required CI gate and local code review. Verify the request-to-capture-to-consumer-to-query path with controlled fixtures before live calls. Once the change is deployed to dev with approval, make small synthetic Jev calls through OpenRouter and TypeSafe and compare returned usage/cost with trace details and usage aggregates. Inspect the UI at narrow and wide widths, including keyboard focus and loading, empty, and error states. Production rollout requires explicit approval.

## Done

- All three native endpoints work through Trace Flow with existing client contracts.
- Both providers produce decision traces with correct requested/resolved models, usage, timing, errors, and accessible captured bodies.
- Jev pricing is discoverable and version-aware; estimated and reported costs remain distinguishable. Aggregate precision is verified and any remaining rounding limit is explicit.
- Batched questions do not multiply request or cost totals, and decision responses are not displayed as generated chat text.
- End-to-end evidence exists for both providers, required checks and local review pass, and integration examples are verified.

## Implementation verification

Worker-runtime integration tests exercise all three routes with synthetic upstream responses,
including encrypted capture before EOF, unchanged bodies and HTTP errors, credential isolation,
and consumer body copying and durable staging before acknowledgment. Direct TypeSafe requests
use its own versioned rate. Unknown versions remain unpriced. OpenRouter catalog indexing gives
real model IDs precedence over canonical names and rejects ambiguous canonical names, so batch
rates cannot overwrite normal rates. The daily import schedules KV synchronization and preserves
manual overrides.

The decision trace panel has been checked in the browser at desktop and 390-pixel widths with
synthetic captured bodies, keyboard expansion, raw display, loading, empty, unavailable, and error
states. The official TypeSafe SDK 0.6.0 exposes the documented `baseURL`, `defaultHeaders`, and
`systemOne` contract, including the `/v1/systemone` suffix.

Aggregate estimates retain the existing integer-microdollar rounding. Tests explicitly cover
repeated small Jev requests; this implementation does not claim exact aggregate spend. Raw
OpenRouter-reported costs retain their original precision.

Research used public documentation and unauthenticated model catalogs. Live response behavior,
account-specific pricing, and a deployed request-to-dashboard check remain dev verification tasks.
