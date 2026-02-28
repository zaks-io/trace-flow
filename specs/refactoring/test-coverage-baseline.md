# Test Coverage Baseline

Generated: 2026-02-25
Branch: team-refactor
Tool: `bunx turbo run test:coverage --filter='*' --force`

---

## Summary

| Package             | Test Files | Tests   | Stmt %                   | Branch % | Func % | Status       |
| ------------------- | ---------- | ------- | ------------------------ | -------- | ------ | ------------ |
| packages/utils      | 12         | 130     | 56.77%                   | 94.83%   | 80%    | Needs work   |
| packages/convex     | 9          | unknown | N/A (no coverage script) | N/A      | N/A    | Critical gap |
| apps/proxy          | 21         | 270     | 87.13%                   | 80.4%    | 89.85% | Good         |
| apps/proxy-consumer | 7          | 131     | 83.36%                   | 72.17%   | 87.5%  | Good         |
| apps/api            | 2          | 12      | 54.05%                   | 88.88%   | 50%    | Critical gap |
| apps/web            | 1          | unknown | ~4% stmts                | mixed    | ~36%   | Critical gap |

Total test files: **52**

---

## Package-by-Package Analysis

### packages/utils

**Test files (12):**

- `computePeriod.test.ts`
- `deriveOperationName.test.ts`
- `extractProviderFromUrl.test.ts`
- `formatBody.test.ts`
- `generateId.test.ts`
- `generateSpanId.test.ts`
- `generateTraceId.test.ts`
- `getCurrentTimestamp.test.ts`
- `hashString.test.ts`
- `parseSpanAttributes.test.ts`
- `traceparent.test.ts`
- `validateTraceId.test.ts`

**Coverage: 56.77% statements / 94.83% branches / 80% functions**

The entire package is a single `index.ts` (870 lines). Statement coverage is low because large sections of the file are not executed by any test, despite branch coverage being high. The v8 coverage provider shows lines 518–870 are largely uncovered.

**Tested:**

- `generateId`, `generateSpanId`, `generateTraceId`
- `getCurrentTimestamp`
- `extractProviderFromUrl`
- `deriveOperationName`
- `validateTraceId` (partial — `validateSpanId` is untested)
- `parseTraceparent`, `formatTraceparent`, `parseBaggage`, `formatBaggage`
- `parseSpanAttributes`
- `hashString`
- `computePeriod`
- `formatBodyForDisplay`, `mergeSSEEvents`

**NOT tested (lines ~518–870):**

- `estimateTokens` (~line 517) — token estimation logic
- `parseMessagesFromBody` (~line 653) — parses messages from request bodies for all providers
- `parseResponseBody` (~line 773) — parses response bodies into `MessageBreakdownData`
- `validateSpanId` (~line 76) — simple but untested variant of `validateTraceId`

These are high-value gaps: `parseMessagesFromBody` and `parseResponseBody` power the message breakdown feature in the UI and are complex multi-provider parsing functions.

---

### packages/convex

**Test files (9):**

- `__tests__/http.test.ts` — HTTP routing (webhook/MCP entrypoint)
- `mcp/__tests__/definitions.test.ts`
- `mcp/__tests__/getTrace.test.ts`
- `mcp/__tests__/getTraceEvents.test.ts`
- `mcp/__tests__/handler.test.ts`
- `mcp/__tests__/listTraces.test.ts`
- `mcp/__tests__/oauth.test.ts`
- `mcp/__tests__/protocol.test.ts`
- `mcp/__tests__/shared.test.ts`

**Coverage: No `test:coverage` script — coverage data unavailable.**

The convex package has no `test:coverage` script in `package.json`. Tests exist for the MCP layer and HTTP routing only.

**Tested:**

- MCP protocol, OAuth, handler, tool definitions, trace queries
- HTTP routing entrypoint

**NOT tested (entire business logic layer):**

- `users.ts` — user creation, profile management
- `apiKeys.ts` — API key CRUD, validation
- `subscriptions.ts` — subscription state management
- `organizations.ts` — org creation, membership
- `usage.ts` — usage queries and aggregation
- `invites.ts` — invite flows
- `auth.ts` — auth helpers and session logic
- `cloudflare.ts` — KV sync actions
- `tinybird.ts` — JWT generation, token management
- `stripeEvents.ts` — Stripe webhook event processing
- `alerts.ts` — alert creation and evaluation
- `modelPricing.ts` — pricing data management
- `pricingSync.ts` — pricing sync logic
- `waitlist.ts` — waitlist management
- `migrations/` — migration scripts

This is the largest untested surface area in the codebase. All Convex mutations and queries for core business logic have zero test coverage.

---

### apps/proxy

**Test files (21):**

- `auth.test.ts`
- `google.test.ts`
- `index.test.ts`
- `parsers/errors.test.ts`
- `parsers/metadata-regex.test.ts`
- `parsers/providers/anthropic.test.ts`
- `parsers/providers/google.test.ts`
- `parsers/providers/groq.test.ts`
- `parsers/providers/index.test.ts`
- `parsers/providers/openai.test.ts`
- `parsers/providers/openrouter.test.ts`
- `parsers/request-body.test.ts`
- `parsers/tokens.test.ts`
- `providers.test.ts`
- `queue.test.ts`
- `storage.test.ts`
- `streaming/capture.test.ts`
- `streaming/sse.test.ts`
- `usage-tracker.test.ts`
- `usage.test.ts`
- `otlp/transform.test.ts`

**Coverage: 87.13% statements / 80.4% branches / 89.85% functions**

**File-level breakdown:**

| File                | Stmts  | Branch | Notes                                               |
| ------------------- | ------ | ------ | --------------------------------------------------- |
| `auth.ts`           | 73.07% | 56.25% | `validateOrgBillingStatus` uncovered (lines 77–128) |
| `index.ts`          | 91.07% | 76.34% | Some error/edge branches uncovered                  |
| `providers.ts`      | 100%   | 100%   | Complete                                            |
| `queue.ts`          | 85.29% | 81.57% | Some edge paths uncovered                           |
| `storage.ts`        | 100%   | 83.33% | One branch (line 47) uncovered                      |
| `usage-tracker.ts`  | 40.81% | 33.33% | **Major gap** — lines 142–319 uncovered             |
| `usage.ts`          | 100%   | 100%   | Complete                                            |
| `otlp/index.ts`     | 59.21% | 58.33% | OTLP ingestion handler has significant gaps         |
| `otlp/transform.ts` | 81.66% | 71.42% | Some transform paths uncovered                      |
| `parsers/*`         | 97.14% | 92.41% | Very good                                           |
| `streaming/*`       | 97.45% | 89.3%  | Very good                                           |

**Key gaps:**

- `usage-tracker.ts` — The `UsageTracker` Durable Object has 40% statement coverage. Lines 142–319 contain the HTTP handler, alarm logic, period rollover, and DO state persistence. These are critical billing paths.
- `auth.ts` `validateOrgBillingStatus` — subscription status checks (suspended/canceled/grace) untested
- `otlp/index.ts` — OTLP ingestion/rejection handler at 59%

---

### apps/proxy-consumer

**Test files (7):**

- `batcher.integration.test.ts`
- `index.integration.test.ts`
- `openrouter-pricing.test.ts`
- `pricing.test.ts`
- `sharding.test.ts`
- `tinybird.test.ts`
- `traces.test.ts`

**Coverage: 83.36% statements / 72.17% branches / 87.5% functions**

| File                    | Stmts  | Branch | Notes                                                 |
| ----------------------- | ------ | ------ | ----------------------------------------------------- |
| `batcher.ts`            | 63.2%  | 45%    | Lines 152–236 uncovered (error handling, retry paths) |
| `index.ts`              | 84.31% | 58.33% | Lines 36–37, 67–69, 109 uncovered                     |
| `openrouter-pricing.ts` | 100%   | 95.45% | Nearly complete                                       |
| `pricing.ts`            | 100%   | 91.17% | Nearly complete                                       |
| `sharding.ts`           | 100%   | 100%   | Complete                                              |
| `tinybird.ts`           | 97.72% | 94.73% | Nearly complete                                       |
| `traces.ts`             | 86.43% | 74.4%  | Lines 70–71, 195–230 uncovered                        |

**Key gaps:**

- `batcher.ts` — The batching error handling and retry logic (lines 152–236) has only 45% branch coverage. This handles queue failures and is a reliability-critical path.
- `traces.ts` — Lines 195–230 (tail of the trace transformation/assembly) are uncovered
- `index.ts` — The queue consumer's error recovery paths are uncovered

---

### apps/api

**Test files (2):**

- `__tests__/auth.test.ts`
- `__tests__/index.test.ts`

**Coverage: 54.05% statements / 88.88% branches / 50% functions**

| File       | Stmts | Branch | Notes             |
| ---------- | ----- | ------ | ----------------- |
| `auth.ts`  | 100%  | 94.11% | Well tested       |
| `index.ts` | 0%    | 0%     | **Zero coverage** |

`index.ts` (94 lines) is the main Hono application that handles R2 body retrieval for requests and responses. The `index.test.ts` file exists but tests only the routing structure (1 test, likely a smoke test). The actual R2 fetch, auth gate, and error handling paths are completely untested.

---

### apps/web

**Test files (1):**

- `src/lib/__tests__/cacheMetrics.test.ts`

**Coverage: ~4% statements overall**

Vitest runs but essentially zero useful coverage exists. The web package is heavily React/Next.js component-based with complex hooks, and the single test only covers `cacheMetrics.ts`.

**Tested:**

- `lib/cacheMetrics.ts` — 100% covered

**NOT tested (~96% of codebase):**

Hooks (all untested):

- `useConvexAuthSession.ts` (217 lines) — auth session management with token refresh
- `useTinybirdPipe.ts` (165 lines) — Tinybird API integration with JWT refresh
- `useLiveTraceDetail.ts` (315 lines) — real-time trace detail fetching
- `useTableFilters.ts`, `useFilterOptions.ts` — filter state management
- `useColumnVisibility.ts`, `useApiKeyMap.ts` — UI state hooks

Lib utilities (all untested):

- `traceToMarkdown.ts` (480 lines) — trace-to-markdown serialization for MCP export
- `alerts.ts` (244 lines) — alert evaluation and rendering logic
- `auth0.ts` (36 lines) — Auth0 client helpers
- `auth-cookies.ts` — cookie management
- `format.ts`, `spans.ts` — display formatting utilities

Components: No component-level tests exist at all (pages, charts, tables, cards).

---

## Coverage Gaps Ranked by Priority

### Priority 1 — Critical (business logic, zero or near-zero coverage)

1. **`packages/convex` business logic** — All mutations and queries for users, API keys, subscriptions, orgs, usage, invites, Stripe events, alerts, and tinybird JWT generation have zero tests. This is ~15 source files covering the entire backend business layer.

2. **`apps/api/src/index.ts`** — The R2 body retrieval handler (0% coverage). Every trace body fetch call goes through this; untested failure modes could silently return corrupt data.

3. **`apps/web` hooks and lib** — `useConvexAuthSession`, `useTinybirdPipe`, `traceToMarkdown` are complex, high-value functions with zero coverage.

### Priority 2 — High (important runtime paths partially tested)

4. **`apps/proxy/src/usage-tracker.ts`** (40% stmts) — Durable Object HTTP handler, alarm logic, and period rollover are untested. Billing correctness depends on this.

5. **`apps/proxy/src/auth.ts`** `validateOrgBillingStatus` (lines 77–128) — All billing-status gating paths (suspended, canceled, grace) are untested.

6. **`apps/proxy-consumer/src/batcher.ts`** (63% stmts, 45% branch) — Queue batch retry and error handling untested.

7. **`apps/proxy/src/otlp/index.ts`** (59% stmts) — OTLP span ingestion handler.

### Priority 3 — Medium (utility functions with partial coverage)

8. **`packages/utils`** `parseMessagesFromBody` and `parseResponseBody` (~lines 653–870) — Powers message breakdown UI; complex multi-provider parsing with no tests.

9. **`packages/utils`** `estimateTokens` (~line 517) — Token estimation used in billing approximation.

10. **`apps/proxy-consumer/src/traces.ts`** (lines 195–230) — Trace assembly tail logic.

---

## Test Infrastructure Notes

- `packages/convex` has no `test:coverage` script — only `test`. Add `"test:coverage": "vitest run --coverage"` to get metrics.
- `apps/web` runs vitest but coverage is misleading because most code is React components that require a browser/jsdom environment and cannot easily run in node vitest.
- `apps/proxy` and `apps/proxy-consumer` use `@cloudflare/vitest-pool-workers` which runs inside the Workers runtime — this adds some test setup overhead but enables accurate DO and KV mocking.
- All tests pass (1 skipped in proxy-consumer for statistical distribution test).
