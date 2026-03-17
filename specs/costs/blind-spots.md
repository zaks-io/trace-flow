# Cost Model Blind Spots

Last updated: 2026-03-06. Based on codebase audit of all workers, Convex functions, and Tinybird config.

The cost model in `cost-analysis.md` is directionally correct but has gaps that could cause surprises at scale. This document ranks them by severity and estimated impact.

---

## CRITICAL: Tinybird Row Count Per Trace

**Model assumes:** 2-5 rows per trace (implied by "5 spans")
**Reality:** 3-15+ rows per trace depending on response type

`buildTraces()` in `apps/proxy-consumer/src/traces.ts` creates:

- 1 root span (always)
- 1 span per content block (thinking, text, tool_use) for streaming responses
- 1 span per tool execution (cross-request tool round-trips)

| Scenario                       | Spans/Trace | vs Model (5) |
| ------------------------------ | ----------- | ------------ |
| Simple non-streaming chat      | 2           | 0.4x         |
| Streaming text-only            | 2           | 0.4x         |
| Streaming with thinking + text | 3           | 0.6x         |
| Streaming + 2 tool calls       | 5-7         | 1-1.4x       |
| Agentic loop (3 tool rounds)   | 8-15        | 1.6-3x       |

**Why it matters:** Tinybird storage is per-byte. Each span is a full row in `otel_traces` with 25 columns including `SpanAttributes` (2-5KB JSON per span). An agentic trace with 10 spans could be 30-50KB in Tinybird, not the modeled 10KB.

**Impact on cost model:**

- Tinybird storage cost could be 2-3x higher for agentic-heavy users
- At 1M traces/mo with avg 8 spans: storage jumps from $1.74 to ~$4-5/mo
- At 5M traces/mo: from $8.70 to ~$20-25/mo

**Also feeds into:** AggregatingMergeTree rollup tables (`llm_usage_1h`, `llm_usage_1d`, `llm_usage_1mo`) consume additional vCPU time proportional to ingestion volume. These exist in `datasources/` and run continuous background aggregation.

---

## HIGH → MEDIUM: Tinybird QPS (Easily Fixable, Not the Real Bottleneck)

**Model assumes:** Tinybird Developer 1 ($99/mo) as baseline
**Current plan:** Developer 0.25 ($25/mo) — 10 QPS, burst to 20
**Reality:** 9 queries per Usage page load, but server-side caching makes this a non-issue

The Usage page (`apps/web/src/components/usage/Usage.tsx`) fires 9 parallel Tinybird queries on load:

1. `llm_usage_summary` (current period)
2. `llm_usage_summary` (previous period)
3. `llm_request_stats`
4. `llm_usage_timeseries`
5. `llm_usage_by_model`
6. `llm_usage_by_provider`
7. `llm_usage_by_operation`
8. `llm_usage_by_api_key`
9. `llm_cost_forecast`

Live trace detail (`useLiveTraceDetail.ts`) polls every 2-30 seconds (exponential backoff).

### Tier Selection by Concurrent Dashboard Users

Developer plans have no daily query limit. The constraint is **QPS** — queries per second sustained (with 2x burst for 1 minute).

| Plan                     | QPS | Burst | Concurrent Page Loads | Monthly |
| ------------------------ | --- | ----- | --------------------- | ------- |
| Developer 0.25 (current) | 10  | 20    | ~2                    | $25     |
| Developer 0.5            | 15  | 30    | ~3                    | $49     |
| Developer 1              | 25  | 50    | ~5                    | $99     |
| Developer 2              | 40  | 80    | ~8                    | $199    |
| Developer 3              | 55  | 110   | ~12                   | $299    |

"Concurrent page loads" = how many users can load the Usage dashboard simultaneously without 429s. Each loads 9 queries in parallel. Live polling adds ~0.3-1 QPS per active user on trace detail.

**Recommendation:**

- **Pre-launch / <10 users:** Developer 0.25 ($25/mo) is fine. 2 concurrent page loads covers solo use + occasional second user.
- **10-30 users with 3-5 concurrent:** Developer 0.5 ($49/mo) or Developer 1 ($99/mo).
- **50+ users:** Developer 1 ($99/mo) minimum. Developer 2 ($199/mo) if team usage patterns cluster (e.g., standup time).

The cost analysis should use Developer 0.25 ($25/mo) for early stage and plan upgrades as user count grows. The $99 assumption is conservative but premature.

### Tinybird Storage by Scale

All Developer plans include 25 GB. Overage: $0.058/GB-month. Ingestion is unlimited (no per-row charge). ClickHouse compresses data ~3-5x with LZ4.

| Scale          | Raw Rows/mo (5 spans avg) | Raw Size | Compressed (~4x) | 90-day Rolling | Within 25 GB?           |
| -------------- | ------------------------- | -------- | ---------------- | -------------- | ----------------------- |
| 100K traces/mo | 500K                      | 2 GB     | ~0.5 GB          | ~1.5 GB        | Yes                     |
| 500K traces/mo | 2.5M                      | 10 GB    | ~2.5 GB          | ~7.5 GB        | Yes                     |
| 1M traces/mo   | 5M                        | 20 GB    | ~5 GB            | ~15 GB         | Yes                     |
| 5M traces/mo   | 25M                       | 100 GB   | ~25 GB           | ~75 GB         | No (+$2.90/mo overage)  |
| 20M traces/mo  | 100M                      | 400 GB   | ~100 GB          | ~300 GB        | No (+$15.95/mo overage) |

Storage stays within 25 GB up to ~2-3M traces/mo. Not a concern until growth stage.

### No query-side caching exists

Every user independently hits Tinybird. 10 users viewing the same org's Usage dashboard = 90 Tinybird queries, not 9 cached ones. This is the #1 thing to fix before scaling past ~5 concurrent dashboard users.

---

## Tinybird Scaling to $30K MRR

### What does $30K MRR look like?

Rough distribution:

| Segment      | Orgs      | Avg Packs/mo | Revenue/org | Segment Revenue | Traces/mo |
| ------------ | --------- | ------------ | ----------- | --------------- | --------- |
| Hobby (free) | 500       | 0            | $0          | $0              | 12.5M     |
| Small Pro    | 350       | 0            | $29         | $10,150         | 35M       |
| Medium Pro   | 100       | 5            | $54         | $5,400          | 60M       |
| Heavy Pro    | 40        | 25           | $154        | $6,160          | 84M       |
| Very Heavy   | 20        | 75           | $404        | $8,080          | 130M      |
| **Total**    | **1,010** |              |             | **~$29,790**    | **~322M** |

~320M traces/mo, ~510 paying orgs, ~1,000 total orgs. Flat $29/org pricing requires more orgs than per-seat to hit $30K MRR.

### Infrastructure costs at $30K MRR (~250M traces/mo)

| Component                                      | Calculation        | Monthly Cost |
| ---------------------------------------------- | ------------------ | ------------ |
| **Fixed**                                      |                    |              |
| Cloudflare Workers Paid                        |                    | $5           |
| Tinybird (tier depends on caching — see below) |                    | $25-$299+    |
| Convex Professional                            |                    | $25          |
| Sentry Team                                    |                    | $26          |
| Domain                                         |                    | $1           |
| **Variable**                                   |                    |              |
| R2 PUTs (500M ops)                             | 250M × 2 × $4.50/M | $2,250       |
| DO SQLite Writes (750M rows)                   | 250M × 3 × $1.00/M | $750         |
| KV Reads (750M)                                | 250M × 3 × $0.50/M | $375         |
| Queue Ops (500M)                               | 250M × 2 × $0.40/M | $200         |
| Workers (275M invocations)                     | $0.30/M            | $83          |
| R2 Storage (3.75 TB rolling)                   | $0.015/GB          | $56          |
| Tinybird Storage (~940 GB, 915 overage)        | $0.058/GB          | $53          |
| DO Requests (275M)                             | $0.15/M            | $41          |
| Convex calls (~2M)                             | $2.00/M            | $4           |
| **Total variable**                             |                    | **~$3,812**  |
| **Total (with Tinybird Dev 0.5)**              |                    | **~$3,906**  |

**Gross margin: ~87%.** $29K revenue - $3.9K infra = $25.1K before Stripe fees. After Stripe (~$1.4K): ~$23.7K net = **81% net margin**.

### The Tinybird QPS Problem (and Why Caching Is Mandatory)

At 315 paying orgs, assume 10% concurrent on dashboard at peak = ~30 orgs with someone loading pages. The Usage page fires **9 parallel queries** on every load.

| Strategy                                        | Burst QPS (30 concurrent loads) | Sustained QPS | Tinybird Tier Needed | Monthly Cost |
| ----------------------------------------------- | ------------------------------- | ------------- | -------------------- | ------------ |
| No caching, 9 queries/page                      | 270 QPS                         | ~30 QPS       | SaaS (custom)        | $1,000+      |
| No caching, 4 queries/page                      | 120 QPS                         | ~15 QPS       | Dev 3 ($299)         | $299         |
| **Server-side cache (60s TTL), 9 queries/page** | 9 QPS (cache misses only)       | ~4.5 QPS      | **Dev 0.25 ($25)**   | **$25**      |
| **Server-side cache + 4 queries/page**          | 4 QPS                           | ~2 QPS        | **Dev 0.25 ($25)**   | **$25**      |

With org-scoped server-side caching (60s TTL), the second person loading the same org's dashboard in the same minute gets cached results — zero Tinybird QPS. Only unique org × query combinations within 60s hit Tinybird.

**Caching alone is the difference between $25/mo and $1,000+/mo on Tinybird at $30K MRR.** Reducing queries from 9 to 4 is nice but secondary.

### Should You Also Reduce Queries Per Page?

Yes, but it's less urgent than caching. Current 9 queries:

| Query                          | Can Combine?       | Notes                                  |
| ------------------------------ | ------------------ | -------------------------------------- |
| `llm_usage_summary` (current)  | Keep               | Primary KPI                            |
| `llm_usage_summary` (previous) | Keep               | Comparison data                        |
| `llm_request_stats`            | Merge into summary | Same time range, aggregated stats      |
| `llm_usage_timeseries`         | Keep               | Different shape (time-bucketed)        |
| `llm_usage_by_model`           | Combine breakdowns | All "by X" queries have same structure |
| `llm_usage_by_provider`        | Combine breakdowns | Could be one query with GROUP BY       |
| `llm_usage_by_operation`       | Combine breakdowns |                                        |
| `llm_usage_by_api_key`         | Combine breakdowns |                                        |
| `llm_cost_forecast`            | Keep               | Different calculation                  |

Realistic reduction: 9 → 4-5 queries by combining the "by X" breakdowns into a single pipe with a dimension parameter, and merging request_stats into the summary query. This halves burst QPS and gives more headroom.

### Tinybird Upgrade Timeline

| Milestone             | Users   | Concurrent Dashboard | Tinybird Tier           | Monthly |
| --------------------- | ------- | -------------------- | ----------------------- | ------- |
| Launch                | 1-10    | 1-2                  | Dev 0.25                | $25     |
| Early growth          | 10-50   | 3-5                  | Dev 0.25 (with caching) | $25     |
| $5K MRR               | 50-100  | 5-10                 | Dev 0.25 (with caching) | $25     |
| $15K MRR              | 200-400 | 15-20                | Dev 0.5 (with caching)  | $49     |
| $30K MRR              | 500-700 | 25-30                | Dev 0.5 (with caching)  | $49     |
| $30K MRR (no caching) | 500-700 | 25-30                | SaaS (custom)           | $1,000+ |

**Bottom line:** Implement server-side Tinybird query caching before you have 10+ concurrent dashboard users. It keeps you on Dev 0.25 ($25/mo) all the way through $30K MRR and possibly beyond. Without it, you're looking at $300-1,000+/mo in Tinybird costs alone.

---

## Tinybird vCPU-Hour Analysis (The "Real" Bottleneck Question)

QPS is trivially fixed with caching. So what actually limits Tinybird scaling? We analyzed vCPU-hour consumption across all 6 datasources at $30K MRR scale.

### What consumes vCPU-hours

On Tinybird's vCPU model, your baseline vCPU runs 24/7. It handles:

- **Ingestion** — parsing, indexing, sorting key maintenance
- **Background merges** — ReplacingMergeTree dedup, AggregatingMergeTree rollups, standard compaction
- **Materialized views** — `otel_traces_genai` processes every row from `otel_traces`
- **Query execution** — dashboard reads, API endpoint calls

### Per-trace data pipeline (5 spans avg)

| Datasource          | Rows/trace | Engine                  | Background Merge Type      |
| ------------------- | ---------- | ----------------------- | -------------------------- |
| `otel_traces`       | 5          | ReplacingMergeTree      | Deduplication merges       |
| `otel_traces_genai` | 5          | ReplacingMergeTree (MV) | Deduplication merges       |
| `llm_requests`      | 1          | MergeTree               | Standard compaction        |
| `llm_usage_1h`      | agg state  | AggregatingMergeTree    | Continuous aggregate merge |
| `llm_usage_1d`      | agg state  | AggregatingMergeTree    | Continuous aggregate merge |
| `llm_usage_1mo`     | agg state  | AggregatingMergeTree    | Continuous aggregate merge |

**11 row inserts + 3 aggregation updates per trace.** The `otel_traces_genai` materialized view effectively doubles ingestion compute for the trace table.

### At $30K MRR (250M traces/mo)

Sustained ingestion rate: **~96 traces/sec → ~1,056 rows/sec** across all tables.

ClickHouse processes 1-5M rows/sec on a single core for typical OLAP schemas. Our 1K rows/sec is ~0.1% of single-core capacity. Even with background merge amplification (3-10x rewrite during compaction), the total CPU demand is modest:

| Activity                                     | Estimated vCPU | vCPU-hours/mo |
| -------------------------------------------- | -------------- | ------------- |
| Ingestion + indexing                         | 0.02-0.05      | 14-36         |
| Background merges (ReplacingMergeTree dedup) | 0.03-0.08      | 22-58         |
| AggregatingMergeTree rollups (3 tables)      | 0.01-0.03      | 7-22          |
| Query execution (with caching, ~5 QPS)       | 0.02-0.05      | 14-36         |
| **Total sustained**                          | **0.08-0.21**  | **57-152**    |

Dev 0.25 includes **150 vCPU-hours/mo** (baseline 0.25 vCPU × 720 hrs = 180 theoretical, 150 included). At the high estimate we're right at the limit, with auto-scale to 0.5 vCPU handling bursts.

### Verdict: No dramatic vCPU bottleneck

| Tinybird Dimension | At $30K MRR                   | Constraint?                      | Cost Impact          |
| ------------------ | ----------------------------- | -------------------------------- | -------------------- |
| QPS                | ~5 QPS (with caching)         | No (Dev 0.25 handles 10 QPS)     | $0                   |
| vCPU-hours         | ~57-152/mo                    | Borderline (150 included)        | $0-$5/mo overage     |
| Storage            | ~75-200 GB (30-day retention) | Yes, exceeds 25 GB               | $2.90-$10/mo overage |
| Ingestion          | ~2.75B rows/mo                | No (unlimited, included in vCPU) | $0                   |

**The honest answer: Tinybird scales cheaply for this workload.** ClickHouse is built for exactly this pattern — high-volume columnar inserts with aggregate rollups. Even at $30K MRR, you're looking at Dev 0.25 ($25/mo) + $3-15 in storage overages + occasional vCPU overages = **$28-45/mo total**.

If vCPU-hours become tight (which would manifest as slower query response times), upgrading to Dev 0.5 ($49/mo, 300 vCPU-hrs) gives 2x headroom. You'd likely stay on Dev 0.5 well beyond $30K MRR.

**The real cost scaling pain is Cloudflare, not Tinybird:** R2 PUTs ($2,250/mo), DO SQLite writes ($750/mo), and KV reads ($375/mo) together are ~$3,375/mo at $30K MRR. Tinybird is ~$30-50/mo. The ratio is roughly **100:1 Cloudflare vs Tinybird**.

---

## HIGH: R2 Body Sizes — Unknown, Needs Measurement

**Model assumes:** 15KB average body size (request + response combined)
**Reality:** Unknown. No production data yet. Theoretical range is enormous.

The proxy stores full request and response bodies in R2 (`apps/proxy/src/storage.ts`). The capture logic (`apps/proxy/src/streaming/capture.ts`) has a 20MB max and no compression.

Body size varies wildly by use case:

- Simple non-streaming chat: 1-5KB
- Streaming text-only: 5-20KB
- Extended thinking (Claude): 20-100KB+
- Multi-tool with conversation history: 10-100KB+

**R2 PUT costs are unaffected** — PUTs are per-operation regardless of size. Only R2 _storage_ scales with body size.

**Action needed:** Instrument actual body sizes in production before adjusting the model. The 15KB assumption could be off in either direction depending on the user mix. Add P50/P95/P99 logging to `storeRequestResponse()` before launch.

---

## MEDIUM: Convex Reactive Query Re-execution

**Model assumes:** Convex calls are negligible (~0.017 per trace)
**Reality:** `recordUsage` mutation triggers reactive re-runs of open dashboards

The flow:

1. UsageTracker DO pushes usage to Convex every ~60 seconds via `pushToConvex()` → HTTP POST to Convex
2. This calls `internal.usage.recordUsage` which mutates the `usage` table
3. Any open `useQuery(api.subscriptions.getBillingSummaryForCurrentUser)` re-executes (reads `subscriptions`, `organizationMembers`, `usage` tables)
4. Two components subscribe to this: `Billing.tsx:18` and `Usage.tsx:57`

**Per active org with open dashboards:** ~1 mutation/minute + N re-executions where N = number of browser tabs watching that org.

This is NOT per-trace (the DO batches to 60-second intervals), so the impact is moderate:

- 100 active orgs × 1 mutation/min × 2 reactive queries = 200 extra queries/min = 12K/hour
- At $2.00/M function calls: ~$0.024/hour — still small

**Where it COULD hurt:** If a team of 10 all has the billing page open during a high-traffic period, each usage push triggers 20 reactive re-executions. At 100 orgs that's 2,000/min = ~$0.24/hour. Still manageable but worth monitoring.

---

## MEDIUM: Tinybird JWT Token Generation

**Model assumes:** Part of "dashboard cost is negligible"
**Reality:** Each new browser session generates a Convex action call per Tinybird pipe

`generateToken` in `packages/convex/tinybird.ts` is a Convex **action** (more expensive than queries). Token cache (`apps/web/src/lib/tinybird.ts`) is:

- Per-pipe, per-browser-session
- TTL: 9 minutes (tokens expire at 10 min)
- Lost on page refresh or navigation

Every new session or page refresh → 1 Convex action per pipe queried. The Usage page queries 9 pipes, so first load = 9 action invocations for token generation (though tokens are cached per-pipe, so subsequent queries to the same pipe reuse).

At 100 DAU × 5 sessions/day × ~3 token generations each = 1,500 action calls/day. Negligible cost ($0.003/day) but the actions also make internal queries (2 per token: user + subscription lookup), so real count is ~4,500 function calls/day.

---

## MEDIUM: API Worker Body Fetch Costs (Dashboard Usage)

**Model assumes:** Dashboard R2 GETs at ~$0.36/M
**Reality:** 3 R2 GETs per body fetch (checking pro/hobby/legacy key paths) + 2 KV reads

When a user clicks to view a trace body in the dashboard:

1. API worker validates auth: 2 KV reads (`user-org:{userSub}` + `sub:{orgId}`)
2. Fetches body: 3 parallel R2 GETs (`requests/pro/{id}`, `requests/hobby/{id}`, `requests/{id}`)

The 3-GET pattern exists to handle tier prefix migration and legacy format (`apps/api/src/index.ts`).

**Impact:** If 50 Pro users each view 20 trace bodies/day:

- R2 GETs: 50 × 20 × 3 × 2 (request + response) = 6,000 GETs/day = 180K/mo = $0.06/mo
- KV reads: 50 × 20 × 2 = 2,000/day = 60K/mo = $0.03/mo
- Negligible in isolation, but the 3x GET multiplier is worth knowing about

---

## MEDIUM: Stripe Webhook Cascading

**Model assumes:** Stripe costs are just processing fees (2.9% + $0.30)
**Reality:** Each Stripe event triggers 7-9 Convex function calls, and Stripe sends multiple events per action

Per webhook event (`packages/convex/http.ts`):

1. `startProcessing` (mutation)
2. Event-specific handler (1-3 queries + 1-2 mutations)
3. `syncSubscriptionToKV` (scheduled action with up to 3 retries)
4. `markProcessed` (mutation)

Subscription creation fires 3+ Stripe events = 21-27 Convex calls.

**Impact:** This is per-billing-event, not per-trace. A single subscription lifecycle (create → N renewals → cancel) might produce 100-200 Convex calls total over months. At $2.00/M, that's $0.0004. Not a cost concern — but the retry logic (3 attempts per KV sync) means a Cloudflare API outage during webhook processing could triple the call count.

---

## LOW: Queue Retry Multiplier on Failures

**Model assumes:** 2 queue operations per trace (send + receive)
**Reality:** Up to 5 retries per message on failure (wrangler.toml `max_retries = 5`)

If the consumer fails to process a message (Tinybird down, DO unavailable), the queue retries up to 5 times. Each retry is:

- 1 additional queue operation
- 1 additional consumer Worker invocation
- 1 additional DO call to TraceBatcher

At a 1% failure rate with 1M traces/mo: 10K retries × 3 extra ops = 30K additional operations/mo. Cost: ~$0.01/mo. Only becomes significant during sustained outages.

---

## LOW: Isolate Recycling Invalidates L1 Cache

The two-layer cache (`apps/proxy/src/cache.ts`) uses a module-scope `Map` as L1. When Cloudflare recycles the Worker isolate, L1 is lost. L2 (Cache API) survives but requires a cache match + response parse. On L2 miss, KV is hit.

Under normal conditions, cache hit rates are 80-90%. During traffic spikes or deployments (which force isolate recycling), KV reads could temporarily spike 2-3x. This is transient, not structural.

---

## Summary: Adjusted Cost Estimates

| Component            | Original Model | Adjusted Estimate | Delta                   |
| -------------------- | -------------- | ----------------- | ----------------------- |
| R2 PUTs (per trace)  | $0.0000090     | $0.0000090        | 0% (confirmed)          |
| DO SQLite writes     | $0.0000030     | $0.0000030        | 0% (confirmed)          |
| KV reads (per trace) | $0.0000015     | $0.0000015        | 0% (cache math holds)   |
| Queue ops            | $0.0000008     | $0.0000008        | 0% (confirmed)          |
| Tinybird storage     | $0.0000006     | $0.0000015        | **+150%** (more spans)  |
| DO requests          | $0.00000017    | $0.00000017       | 0% (batching confirmed) |
| Workers              | $0.0000003     | $0.0000003        | 0%                      |
| **Total per trace**  | **$0.0000150** | **$0.0000159**    | **+6%**                 |

The per-trace cost increase is modest (~6%) because the dominant cost (R2 PUTs at 60%) is confirmed accurate. The Tinybird storage increase matters more at scale and with longer retention.

**The real risks are not per-trace costs but Cloudflare operational costs:**

| Risk                            | When It Bites                         | Estimated Impact                    |
| ------------------------------- | ------------------------------------- | ----------------------------------- |
| **R2 PUTs dominate cost**       | Always — 60% of per-trace cost        | $2,250/mo at $30K MRR               |
| **DO SQLite writes scale fast** | Always — 2nd largest cost component   | $750/mo at $30K MRR                 |
| R2 body sizes unknown           | Until measured in production          | Storage costs could be 1-5× modeled |
| Agentic trace storage bloat     | Users with heavy tool-use workflows   | 2-3× Tinybird storage costs         |
| Tinybird QPS (without caching)  | >2 concurrent dashboard loads         | Solved with server-side caching     |
| Convex reactive re-runs         | Many open dashboards during ingestion | Negligible cost, but wasted compute |

**Key insight: Tinybird is NOT the scaling bottleneck.** At $30K MRR, Tinybird costs ~$30-50/mo while Cloudflare costs ~$3,375/mo. The 100:1 ratio means optimization effort should focus on Cloudflare (R2 write batching, DO consolidation) not Tinybird.

---

## Recommended Actions

### Before Launch

1. **Add Tinybird query result caching** — Server-side cache for Usage dashboard queries (60s TTL). Eliminates N× query multiplication across users viewing the same org.
2. **Consolidate API worker R2 lookups** — Store tier prefix in trace metadata so the API worker can do 1 GET instead of 3.

### After Launch (Monitor First)

3. **Instrument actual span count per trace** — Add a histogram to validate the 5-span assumption. If agentic users dominate, adjust storage cost model.
4. **Instrument actual body sizes** — Log P50/P95/P99 of R2 PUT sizes to validate the 15KB assumption.
5. **Monitor Tinybird QPS and daily query usage** — Set alerts at 80% of plan limits.
6. **Consider Tinybird query budgets per org** — If one user's polling consumes disproportionate quota, implement client-side rate limiting.

### Optimization Opportunities

7. **Batch R2 writes** (already identified in cost-analysis.md) — Remains the #1 cost optimization at 30% reduction.
8. **Compress R2 bodies** — gzip before PUT. LLM text compresses 70-80%. Reduces storage costs, R2 bandwidth on reads.
9. **Share Tinybird JWT tokens across pipes** — Generate one token per session with access to all pipes, not one per pipe.
