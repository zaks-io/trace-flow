# Opus 5.5 focused implementation review

Reviewed the uncommitted working tree against baseline `e3643a9f19da87fe8cb03fb6f8c89f16c9ce68ba`.
Session: `77ba62d0-fbed-4d20-bcd8-0466c3a16512`, high effort, read-only static review.

This report preceded the final privacy scrubbers and nested-action latency correction.
Those changes receive a separate final delta review; this report is not final approval.

# Focused re-review of the trace-correlation fixes

**Verdict: not yet clean.** All the correlation findings from my last review are fixed. But one material privacy gap remains on the Sentry capture path that fix 5 says it closed. It existed before this branch, so it isn't a regression, but the handoff currently states a privacy contract the code doesn't meet. Once that's fixed and the final full local CI is green, I'd approve the local handoff. That approval doesn't extend to deploy, commit or merge.

This was a static review against the settled working tree; I didn't run any tests.

## P1 (pre-existing): query strings and unfiltered request headers still reach Sentry

`sentryRequestPrivacy()` (`packages/utils/src/sentry-tracing.ts:11-18`) only controls the request-data and HTTP-body integrations. Two other capture paths in the pinned SDK ignore those settings:

- **Query strings.** On every `http.server` span, `@sentry/cloudflare/build/esm/request.js:21` calls `getHttpSpanDetailsFromUrlObject`. That function sets `url.query` and `url.full` (the full URL including the query) with no filtering (`@sentry/core/build/esm/utils/url.js:65-78`).
  - **How it leaks:** a Gemini client calls the Proxy with `/google/v1beta/models/...:generateContent?key=<provider key>`. The Proxy forwards the query unchanged (`forwardToUpstream.ts:83-84`), and the provider key lands in our Sentry transaction.
  - Error events probably also carry the full URL in `request.url`; the SDK always includes the URL there.
- **Request headers.** `request.js:32-35` copies request headers into `http.request.header.*` span attributes. With `sendDefaultPii: false` this uses a deny list (`defaultPiiToCollectionOptions.js:19`, `filterKeyValueData.js:18-25`):
  - Names containing `auth` or `key` are redacted, so the `authorization`, `x-api-key` and `X-Trace-Flow-Api-Key` headers are safe. That's why the current tests pass.
  - Customer `baggage`, `tracestate`, `sentry-trace`, `openai-organization` and `openai-project` are recorded verbatim. Customer baggage is exactly what the new AGENTS.md rule keeps away from Convex.

The new production-options tests (`streaming-trace-context.integration.test.ts`, the OTLP failure test) only plant private markers in the body and in a header whose name contains `key`. Neither path above is exercised.

**Fix:**

1. Add `beforeSendTransaction` and `beforeSend` next to `sentryRequestPrivacy`, applied wherever it's used now. They should drop `url.query` and `url.fragment`, remove the query from `url.full`, `http.url` and `event.request.url`, and drop `http.request.header.*` (or keep only an explicit allow-list).
2. Don't use the `dataCollection` option for this. As soon as it's set at all, every field it doesn't name falls back to the permissive defaults: user info, cookies, all bodies and AI inputs/outputs (`resolveDataCollectionOptions.js:3-16`). It also doesn't gate `url.query`.
3. Add a test using the exported `proxySentryOptions` with `?key=<canary>` and `baggage: customer=<canary>`, asserting that no event or transaction envelope contains either canary.

## P3

- **Convex nested actions still wait up to 2 s.** HTTP routes now flush within 250 ms (`convexTracing.ts:123`). But `authorizePipesQuery` and `generateTokenInternal` run inside `/worker/authorize-pipes-query` and `/mcp-backend/mint`, and they still wait up to 2000 ms. If Sentry stalls, those routes can still add about 2.25 s. `pipes-api/src/authorization.ts` sets no timeout. Fix: pass the HTTP timeout into actions called with a request trace context.
- **Stored sampling flag follows our SDK sampler.** The domain flag now comes from the SDK's sampling decision (`validateRequest.ts:196-198`). That's correct at today's sample rate of 1. If the rate is ever lowered, customer span flags would change with our sampler; worth a line in the audit doc.

## Prior findings, now resolved

| Prior finding                                     | Status                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Async context lost when a cold DO starts (P1)     | Fixed at the root        | The patch moves the `AsyncLocalStorage` allocation to module scope in both ESM and CJS builds. It's registered in `package.json:71-72` and `bun.lock:448-449`, and the installed SDK file carries it. No per-call restoration helpers remain in app code. Tests cover cold DO-to-DO (`agent-delivery-tracing.integration.test.ts:145,280`), overlapping requests with an unrelated cold constructor and cold snapshot failures (`snapshot-tracing-cold.integration.test.ts`), and concurrent streaming (`streaming-trace-context.integration.test.ts`). |
| Producer context failed open to a shared trace ID | Fixed                    | `currentSentryTraceContext` reads only the active span, returns `{}` without one, and carries no baggage (`sentry-tracing.ts:40-47`). `internalTraceHeaders` reuses it.                                                                                                                                                                                                                                                                                                                                                                                 |
| Remote-error skip                                 | Your call is correct     | `delivery-queue.ts:23-27` always captures, safely. The extra caller event uses a separate `agent_delivery.dispatch` fingerprint. Because `remote` can also mean a platform failure where the receiver never ran, a bounded duplicate is better than a dropped failure.                                                                                                                                                                                                                                                                                  |
| Baggage in durable queue messages                 | Fixed                    | Covered by the `currentSentryTraceContext` change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Convex HTTP latency                               | Fixed at the route level | 250 ms bound on HTTP routes; see the P3 above for nested actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Root-span regression                              | Fixed                    | Requests with no trace header or only a Sentry header stay domain roots (`validateRequest.ts:194-195`).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

None of the protected behaviours I checked before (stream tee, R2 before end of stream, ack and staging order, the reference contract, causal links) were touched by these fixes. The diff is confined to tracing setup, Sentry options and scope plumbing.
