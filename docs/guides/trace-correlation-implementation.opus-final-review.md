# Opus 5.5 final delta review

Persistent session: `77ba62d0-fbed-4d20-bcd8-0466c3a16512`. High effort, read-only static review of uncommitted working tree at `e3643a9f19da87fe8cb03fb6f8c89f16c9ce68ba`.

Source fingerprint at review start: `6346c32d3b58b4d4d0b1f5f7a8bb986ae42b238e87e940bd0afc40be0c765a66`.

The separate full CI then caught missing alarm links caused by the SDK's `beforeSendSpan` root conversion, and an obsolete consumer mock. The correction receives a focused delta review. This report's conditional approval is not completion evidence by itself.

# Final delta review of the trace-correlation work

**Verdict: conditional approval for local handoff, provided the separate full local CI run passes.** I found no material issues in the final delta.

**Scope:** a static review of the current files in the uncommitted working tree on base `e3643a9`. I didn't run any tests. Earlier conclusions for unchanged areas still stand. This approves nothing for deploy, commit or merge.

## 1. Sentry request privacy: resolved

**Ordering is correct in the pinned SDK:**

- `processBeforeSend` runs before `sendEvent` (`@sentry/core/build/esm/client.js:593,631`).
- The envelope `trace` header is read from `sdkProcessingMetadata.dynamicSamplingContext` only after that (`utils/envelope.js:143-151`), so the replacement at `sentry-tracing.ts:80` is what gets exported.
- When a transaction has child spans, core copies the metadata object before calling `beforeSendTransaction` (`client.js:780-787`). The scrubber replaces the field on that copy, so the span's own sampling context is left untouched.

**Every capture path is covered:**

- `beforeSendSpan` runs on both the root span and every child span (`client.js:744-777`).
- Inbound `http.server` attributes (`url.query`, `url.full`, `http.request.header.*`) and fetch span attributes (`url`, `http.url`, `url.full`, `http.query`, `http.fragment`; `fetch.js:193-213`) all match the scrub keys.
- Fetch span names are already stripped of the query by core (`fetch.js:186-189`).
- Error-event request data and fetch breadcrumbs are scrubbed.
- The Worker logger only records the pathname, so console breadcrumbs don't carry query strings.

**Sampling context:**

- Kept: `trace_id` (from the event's own trace context), `public_key` (from our client's DSN, not from incoming baggage), validated `sample_rate` and `sample_rand`, and `sampled`.
- Dropped: arbitrary `sentry-*` fields and spoofed values.
- If a field is missing or invalid, it is simply omitted. As far as I know, Relay then ignores that sampling context rather than the event; I couldn't fetch the DSC spec page you linked, so I haven't checked this against it. Trace and span identity on the event itself is unaffected either way.

**Coverage:**

- All 15 production Worker and DO options callbacks spread the helper, and none override `integrations` or `beforeSend*` afterwards.
- The Web Worker keeps `skipOpenTelemetrySetup` after the spread.
- No `dataCollection` option is used anywhere.
- The Web Worker's `enableLogs` has no log emitters in source, so log items (which bypass `beforeSend`) aren't a channel today.

**Test:** `request-privacy.integration.test.ts` uses the exported `proxySentryOptions` and serializes complete envelopes, headers included. It plants canaries in the query, fragment, customer baggage, a spoofed `sentry-public_key`, an arbitrary header and the Proxy API key. The forwarded upstream `?key=` also passes through the SDK-wrapped fetch, so child spans are exercised. It also asserts `trace_id` and `public_key` survive.

## 2. Convex flush latency: resolved

- `convexTracing.ts:123` flushes within 250 ms for HTTP routes and for actions continued from a serialized trace context. Standalone roots get 2000 ms.
- Worst case for a nested route plus action is about 500 ms, as the source comment states.
- Stalled-exporter tests exist at `convexTracing.test.ts:149` and `convexTracing.actions.test.ts:152`.

## 3. Domain sampling flag: resolved

- `validateRequest.ts:196-198` takes the sampled bit from the active SDK span and keeps the other W3C flag bits.
- `failure-tracing.integration.test.ts:82-151` covers four cases: no header, a Sentry header with and without the sampled flag, and W3C. It asserts the stored flag matches the durable header's sampling bit, and that only W3C requests get a stored parent span ID.

## 4. Fact-batcher change: no behavior change

The constant's only use is `fact-batcher.ts:661-667`. Each chunk is 1 + 30 bindings, the same as before.

## P3 (optional)

- **Dynamic-sampling inputs:** the scrubber also drops our own trusted `environment`, `release` and `transaction` from the sampling context. Sentry's server-side dynamic-sampling rules keyed on those lose that input if they're in use. If that matters, fill `environment` and `release` from the active client's options.
- **Sample-rate format:** the `sample_rate` check rejects exponent forms such as `1e-5`, which only incoming customer-headed traces could carry. The field is then omitted, which has no correctness impact.
- **Misleading comment:** `fact-batcher.ts:87` says "Three bindings per row", but its only use is a one-binding-per-ID `UPDATE`.

The limitations recorded in `docs/guides/trace-correlation-audit.md` still apply as written: native platform IDs are mapped, not unified; hosted export, browser and OpenNext parentage are unverified; authenticated Convex codegen is still needed before deploy; and validation ran on Bun 1.4.2.
