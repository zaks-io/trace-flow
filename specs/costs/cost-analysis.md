# Trace Flow Cost Analysis

Last updated: 2026-03-10

> **Status:** This is a legacy pricing model. It predates the current single encrypted
> `bodies/{requestId}` object, the agent ingest/consumer pipeline, and any post-2026-03-10 pricing
> refresh. Use it for historical reasoning only until the full cost model is recalculated.
> Current Cloudflare cost drivers are summarized in `cloudflare-pricing.md`.

## Tech Stack Cost Summary

### Fixed Monthly Costs (Base Fees)

| Service                 | Role                                                                  | Base Cost                |
| ----------------------- | --------------------------------------------------------------------- | ------------------------ |
| Cloudflare Workers Paid | Proxy, proxy consumer, agent ingest, agent consumer, API, Web runtime | $5/mo                    |
| Tinybird Developer 1    | Trace analytics (ClickHouse)                                          | $99/mo                   |
| Convex Professional     | Backend DB, auth, billing logic                                       | $25/dev/mo               |
| Sentry Team             | Error monitoring across workers                                       | $26/mo                   |
| Domain (trace-flow.dev) | DNS                                                                   | ~$1/mo                   |
| **Total fixed**         |                                                                       | **$156/mo** (single dev) |

Tinybird tier scales with concurrent dashboard users (QPS is the binding constraint, not storage or ingestion). Upgrade path: Dev 0.5 ($49) at ~10 users, Dev 1 ($99) at ~30 users, Dev 2 ($199) at ~50+ users. See `blind-spots.md` for full QPS analysis.

Auth0 (free to 25K MAU), GitHub Actions (free to 3K min/mo), and Stripe (no base fee) have no fixed costs at reasonable scale.

### Variable Costs (Overage Rates)

| Service              | Metered Resource      | Rate             |
| -------------------- | --------------------- | ---------------- |
| Cloudflare Workers   | Requests              | $0.30/M          |
| Cloudflare R2        | Class A ops (PUT)     | $4.50/M          |
| Cloudflare R2        | Class B ops (GET)     | $0.36/M          |
| Cloudflare R2        | Storage               | $0.015/GB-mo     |
| Cloudflare KV        | Reads                 | $0.50/M          |
| Cloudflare KV        | Writes                | $5.00/M          |
| Cloudflare Queues    | Operations (per 64KB) | $0.40/M          |
| Cloudflare DO        | Requests              | $0.15/M          |
| Cloudflare DO SQLite | Row writes            | $1.00/M          |
| Cloudflare DO SQLite | Row reads             | $0.001/M         |
| Tinybird             | Storage overage       | $0.058/GB-mo     |
| Tinybird             | vCPU-hour overage     | $0.162/hr        |
| Convex               | Function calls        | $2.00/M (Pro)    |
| Stripe               | Card processing       | 2.9% + $0.30/txn |
| Stripe               | Tax                   | 0.5%/txn         |

---

## Per-Request Cost Breakdown

### Operations Per Recorded Trace (Scenario A - Legacy Baseline)

Full path: Client -> Proxy -> Queue -> Consumer -> Tinybird + R2

| Service         | Operation                              | Count/Trace   | Unit Price (Overage) | Cost/Trace     |
| --------------- | -------------------------------------- | ------------- | -------------------- | -------------- |
| Workers         | Proxy invocation                       | 1             | $0.30/M              | $0.0000003     |
| Workers         | Consumer invocation                    | 0.1 (batched) | $0.30/M              | $0.00000003    |
| KV              | Reads (auth + billing + pricing)       | 3             | $0.50/M              | $0.0000015     |
| R2              | PUTs (request + response body objects) | 2             | $4.50/M              | $0.0000090     |
| R2              | Storage (15KB avg, 30-day retention)   | 15KB          | $0.015/GB-mo         | $0.00000023    |
| Queues          | Operations (send + receive)            | 2             | $0.40/M              | $0.0000008     |
| Durable Objects | Requests (UsageTracker + TraceBatcher) | 1.1           | $0.15/M              | $0.00000017    |
| DO SQLite       | Row writes (counters + trace inserts)  | 3             | $1.00/M              | $0.0000030     |
| DO SQLite       | Row reads (config + counters)          | 5             | $0.001/M             | $0.000000005   |
| Tinybird        | Ingestion (2-20 rows)                  | N/A           | $0 (unlimited)       | $0             |
| Tinybird        | Storage (~10KB/trace, 90-day TTL)      | 10KB          | $0.058/GB-mo         | $0.0000006     |
| Convex          | Usage push (amortized, 1/60s)          | 0.017         | $2.20/M              | $0.00000004    |
| **Total**       |                                        |               |                      | **$0.0000150** |

**Marginal cost per recorded trace: ~$0.015 per 1,000 traces ($15/million traces)**

The dominant cost driver in this legacy two-object model is **R2 PUT operations** (60% of per-trace cost), followed by **DO SQLite writes** (20%).

### Operations Per Passthrough Request (Scenario B - No Recording)

When a request is proxied but NOT recorded (billing suspended, limits exceeded, etc.):

| Service         | Operation                          | Count/Request | Unit Price (Overage) | Cost/Request   |
| --------------- | ---------------------------------- | ------------- | -------------------- | -------------- |
| Workers         | Proxy invocation                   | 1             | $0.30/M              | $0.0000003     |
| KV              | Reads (auth + billing)             | 2             | $0.50/M              | $0.0000010     |
| Durable Objects | Request (usage check, conditional) | 0-1           | $0.15/M              | $0.00000015    |
| DO SQLite       | Reads (conditional)                | 0-2           | $0.001/M             | $0.000000002   |
| **Total**       |                                    |               |                      | **$0.0000015** |

**Marginal cost per passthrough: ~$0.0015 per 1,000 requests ($1.50/million requests)**

### Dashboard View (Scenario C)

Per page load (authenticated user viewing traces):

| Service  | Operation                        | Count         | Unit Price                      | Cost             |
| -------- | -------------------------------- | ------------- | ------------------------------- | ---------------- |
| Convex   | Queries (preload + runtime)      | 3-5           | $2.20/M                         | $0.000011        |
| Convex   | Action (Tinybird JWT generation) | 1             | $2.20/M                         | $0.0000022       |
| Tinybird | Pipe queries                     | 1-3           | Counted against QPS/daily limit | $0 (within plan) |
| Workers  | API invocation (body fetch)      | 0-1 per click | $0.30/M                         | $0.0000003       |
| R2       | GETs (body retrieval)            | 0-3 per click | $0.36/M                         | $0.0000011       |

**Dashboard cost is negligible** -- dominated by Convex function calls at ~$0.01/1000 page views.

---

## User Cost Modeling (At Overage Rates)

All costs calculated at full overage rates -- no free tier padding. This is what each user actually costs you to serve.

### Assumptions

- Average trace size: 15KB in R2, 10KB in Tinybird (5 spans)
- Streaming responses average 5 spans per trace
- Pro retention: 30 days R2, 90 days Tinybird TTL
- Hobby retention: 7 days R2, 90 days Tinybird TTL
- Dashboard usage: ~100 page views/month per active user
- Tinybird ingestion is unlimited (no per-event charge)

### Hobby User (25K traces/month)

| Component                             | Usage   | Unit Cost    | Monthly Cost |
| ------------------------------------- | ------- | ------------ | ------------ |
| Worker invocations                    | 27.5K   | $0.30/M      | $0.01        |
| KV reads                              | 75K     | $0.50/M      | $0.04        |
| R2 PUTs                               | 50K     | $4.50/M      | $0.23        |
| R2 storage (7-day rolling)            | 85 MB   | $0.015/GB-mo | $0.001       |
| Queue operations                      | 50K     | $0.40/M      | $0.02        |
| DO requests                           | 27.5K   | $0.15/M      | $0.004       |
| DO SQLite writes                      | 75K     | $1.00/M      | $0.08        |
| Tinybird storage (90-day rolling)     | 0.75 GB | $0.058/GB-mo | $0.04        |
| Convex calls (usage push + dashboard) | ~1.5K   | $2.00/M      | $0.003       |
| Dashboard (Convex queries)            | ~250    | $2.00/M      | $0.001       |
| **Total variable cost**               |         |              | **$0.43/mo** |

### Moderate Pro User (100K traces/month)

| Component                         | Usage  | Unit Cost    | Monthly Cost |
| --------------------------------- | ------ | ------------ | ------------ |
| Worker invocations                | 110K   | $0.30/M      | $0.03        |
| KV reads                          | 300K   | $0.50/M      | $0.15        |
| R2 PUTs                           | 200K   | $4.50/M      | $0.90        |
| R2 storage (30-day rolling)       | 1.5 GB | $0.015/GB-mo | $0.02        |
| Queue operations                  | 200K   | $0.40/M      | $0.08        |
| DO requests                       | 110K   | $0.15/M      | $0.02        |
| DO SQLite writes                  | 300K   | $1.00/M      | $0.30        |
| Tinybird storage (90-day rolling) | 3 GB   | $0.058/GB-mo | $0.17        |
| Convex calls                      | ~5K    | $2.00/M      | $0.01        |
| **Total variable cost**           |        |              | **$1.68/mo** |

### Heavy Pro User (1M traces/month)

| Component                         | Usage | Unit Cost    | Monthly Cost  |
| --------------------------------- | ----- | ------------ | ------------- |
| Worker invocations                | 1.1M  | $0.30/M      | $0.33         |
| KV reads                          | 3M    | $0.50/M      | $1.50         |
| R2 PUTs                           | 2M    | $4.50/M      | **$9.00**     |
| R2 storage (30-day rolling)       | 15 GB | $0.015/GB-mo | $0.23         |
| Queue operations                  | 2M    | $0.40/M      | $0.80         |
| DO requests                       | 1.1M  | $0.15/M      | $0.17         |
| DO SQLite writes                  | 3M    | $1.00/M      | $3.00         |
| Tinybird storage (90-day rolling) | 30 GB | $0.058/GB-mo | $1.74         |
| Convex calls                      | ~50K  | $2.00/M      | $0.10         |
| **Total variable cost**           |       |              | **$16.87/mo** |

### Extreme User (5M traces/month)

| Component                         | Usage  | Unit Cost    | Monthly Cost  |
| --------------------------------- | ------ | ------------ | ------------- |
| Worker invocations                | 5.5M   | $0.30/M      | $1.65         |
| KV reads                          | 15M    | $0.50/M      | $7.50         |
| R2 PUTs                           | 10M    | $4.50/M      | **$45.00**    |
| R2 storage (30-day rolling)       | 75 GB  | $0.015/GB-mo | $1.13         |
| Queue operations                  | 10M    | $0.40/M      | $4.00         |
| DO requests                       | 5.5M   | $0.15/M      | $0.83         |
| DO SQLite writes                  | 15M    | $1.00/M      | $15.00        |
| Tinybird storage (90-day rolling) | 150 GB | $0.058/GB-mo | $8.70         |
| Convex calls                      | ~250K  | $2.00/M      | $0.50         |
| **Total variable cost**           |        |              | **$84.31/mo** |

### Cost Per User Summary

| User Type    | Traces/mo | Variable Cost | Cost/1K Traces |
| ------------ | --------- | ------------- | -------------- |
| Hobby        | 25K       | $0.43         | $0.017         |
| Moderate Pro | 100K      | $1.68         | $0.017         |
| Heavy Pro    | 1M        | $16.87        | $0.017         |
| Extreme      | 5M        | $84.31        | $0.017         |

Cost scales linearly at **~$0.017 per 1,000 traces** ($17/million traces) regardless of user size.

---

## Platform-Level Cost Scenarios (Full Cost)

All scenarios include fixed base fees + variable usage at overage rates.

### Scenario: 50 Users (10 Pro + 40 Hobby)

2M Pro traces + 800K Hobby traces = 2.8M total traces/mo.

| Item                                     | Monthly Cost  |
| ---------------------------------------- | ------------- |
| **Fixed costs**                          |               |
| Cloudflare Workers Paid                  | $5.00         |
| Tinybird Developer 0.5                   | $49.00        |
| Convex Pro (1 dev)                       | $25.00        |
| Sentry Team                              | $26.00        |
| Domain                                   | $1.00         |
| **Variable costs (2.8M traces)**         |               |
| R2 PUTs (5.6M)                           | $25.20        |
| R2 Storage (~25 GB)                      | $0.38         |
| KV Reads (8.4M)                          | $4.20         |
| Queue Ops (5.6M)                         | $2.24         |
| Worker Requests (3.1M)                   | $0.93         |
| DO Requests (3.1M)                       | $0.47         |
| DO SQLite Writes (8.4M)                  | $8.40         |
| Tinybird Storage (~84 GB, 59 GB overage) | $3.42         |
| Convex calls (~150K)                     | $0.30         |
|                                          |               |
| **Total**                                | **~$146/mo**  |
| **Per user**                             | **~$2.93/mo** |
| **Per Pro user (variable only)**         | **~$3.37/mo** |
| **Per Hobby user (variable only)**       | **~$0.43/mo** |

### Scenario: 200 Users (50 Pro + 150 Hobby)

15M Pro traces + 4.5M Hobby traces = 19.5M total traces/mo.

| Item                                       | Monthly Cost  |
| ------------------------------------------ | ------------- |
| **Fixed costs**                            |               |
| Cloudflare Workers Paid                    | $5.00         |
| Tinybird Developer 2                       | $199.00       |
| Convex Pro (1 dev)                         | $25.00        |
| Sentry Team                                | $26.00        |
| Domain                                     | $1.00         |
| **Variable costs (19.5M traces)**          |               |
| R2 PUTs (39M)                              | $175.50       |
| R2 Storage (~175 GB)                       | $2.63         |
| KV Reads (58.5M)                           | $29.25        |
| Queue Ops (39M)                            | $15.60        |
| Worker Requests (21.5M)                    | $6.45         |
| DO Requests (21.5M)                        | $3.23         |
| DO SQLite Writes (58.5M)                   | $58.50        |
| Tinybird Storage (~585 GB, 560 GB overage) | $32.48        |
| Convex calls (~1M)                         | $2.00         |
| R2 GETs (dashboard, ~60K)                  | $0.02         |
|                                            |               |
| **Total**                                  | **~$582/mo**  |
| **Per user**                               | **~$2.91/mo** |
| **Per Pro user (variable only)**           | **~$5.06/mo** |
| **Per Hobby user (variable only)**         | **~$0.43/mo** |

---

## Cost Per Million Requests: Passthrough vs Recorded

| Metric                 | Passthrough (no recording) | Recorded Trace                   |
| ---------------------- | -------------------------- | -------------------------------- |
| Cost per 1M requests   | **$1.50**                  | **$15.00**                       |
| Dominant cost          | KV reads (67%)             | R2 PUTs (60%)                    |
| Storage cost (ongoing) | $0                         | ~$0.90/M/month (decays with TTL) |

A user sending 1M requests/month through the proxy **without recording** costs ~$1.50/month. With recording, it's ~$15/month plus ongoing storage.

---

## Stripe Revenue Impact

For every dollar of subscription revenue collected:

| Component             | Rate         | On $29 subscription |
| --------------------- | ------------ | ------------------- |
| Card processing       | 2.9% + $0.30 | $1.14               |
| Stripe Tax            | 0.5%         | $0.145              |
| **Total Stripe fees** |              | **~$1.29 (~4.4%)**  |

For addon packs ($5/100K units):

| Component             | Rate         | On $5 addon       |
| --------------------- | ------------ | ----------------- |
| Card processing       | 2.9% + $0.30 | $0.45             |
| Stripe Tax            | 0.5%         | $0.03             |
| **Total Stripe fees** |              | **$0.48 (~9.5%)** |

Small transactions have disproportionately high Stripe fees due to the $0.30 fixed component.

---

## Key Cost Drivers (Ranked)

At scale, these are the dominant costs:

1. **R2 PUT operations** -- the current implementation writes one encrypted combined `bodies/{requestId}` object per recorded trace. Older estimates in this file assumed two PUTs and need recalculation.
2. **Tinybird plan + storage** -- Fixed plan cost ($25-299 depending on QPS needs) + storage grows with retention. At 90-day TTL, storage accumulates 3x monthly ingestion. QPS is the binding constraint — tier upgrades driven by concurrent dashboard users, not trace volume.
3. **KV reads** -- $0.50/M, 2-3 per request. The two-layer cache helps but every cache miss hits KV. At scale this adds up.
4. **Convex plan** -- $25/dev/mo is a fixed cost that kicks in once you exceed free tier limits.
5. **DO SQLite writes** -- $1.00/M, 3 per trace. Small but grows linearly.
6. **Queue operations** -- $0.40/M, 2 per trace. Cheap but adds up.

---

## Pricing Recommendations

### Proposed Tiers

#### Hobby (Free)

- **Price:** $0
- **Included traces:** 25,000/month per org
- **Retention:** 7 days (R2 bodies), 90 days (Tinybird analytics)
- **Overage:** Hard blocked -- no trace packs available
- **Our variable cost:** $0.43/mo

Purpose: acquisition funnel. 25K traces is generous compared to competitors (LangSmith: 5K, Helicone: 10K), enough to evaluate the product with real workloads, not enough to run production on.

#### Pro ($29/mo per org)

- **Price:** $29/org/month
- **Included traces:** 100,000/month per org
- **Members:** Unlimited (flat per org)
- **Retention:** 30 days (R2 bodies), 90 days (Tinybird analytics)
- **Overage:** Trace packs (see below), auto-topup available
- **Our variable cost for included traces:** $1.70/mo

Why $29:

- At $29, net after Stripe (2.9% + $0.30 + 0.5% tax) is **$27.71/org**.
- After subtracting the $1.70 variable cost for 100K included traces: **$26.01 net margin/org** (90%).
- Market positioning: $29 flat is cheaper than LangSmith $39/seat for any team, comparable to Helicone $20/seat for solo.
- Single org covers its own fixed cost share and then some.

### Trace Packs (Pro Only)

**$5 per 100K traces.** One price, one size, buy as many as you need.

| Metric            | Value                             |
| ----------------- | --------------------------------- |
| Price             | $5 per 100K traces                |
| Effective rate    | $0.05 per 1K traces ($50/million) |
| Our cost per 100K | $1.70                             |
| Stripe fees on $5 | $0.45 (2.9% + $0.30)              |
| **Net per pack**  | **$2.85**                         |
| **Gross margin**  | **57%**                           |

Why $5 instead of $8:

- **Lower friction.** $5 is an impulse buy. $8 makes people think twice.
- **Customer math is easy.** $5/100K. $50/million. No mental gymnastics.
- **Still healthy margin.** 57% after Stripe. Gets better in bulk (see below).
- **Competitive.** LangSmith charges ~$50/100K extra traces. Helicone charges ~$20/100K. $5 is aggressively cheap -- this becomes a selling point.
- **Volume drives revenue.** A heavy user buying 10 packs ($50) generates more total profit than a user who balks at $8 and stays conservative.

The floor before we lose money is ~$3/100K. We have room.

#### Stripe Fee Efficiency on Trace Packs

The $0.30 fixed Stripe fee hurts on small transactions. Auto-topup and bulk purchases help:

| Purchase Size | Traces | Total Price | Stripe Fee   | Our Cost | Net Margin |
| ------------- | ------ | ----------- | ------------ | -------- | ---------- |
| 1 pack        | 100K   | $5          | $0.45 (9.0%) | $1.70    | 57%        |
| 2 packs       | 200K   | $10         | $0.59 (5.9%) | $3.40    | 60%        |
| 5 packs       | 500K   | $25         | $1.03 (4.1%) | $8.50    | 62%        |
| 10 packs      | 1M     | $50         | $1.75 (3.5%) | $17.00   | 63%        |

Encouraging users to buy in larger quantities (via the existing `quantity` parameter on checkout) improves margins. The auto-topup flow handles this naturally since it fires less frequently than individual small purchases.

### Full Unit Economics

What a Pro user actually looks like at various usage levels:

| Usage          | Subscription | Trace Packs Needed | Pack Revenue | Total Revenue | Our Variable Cost | Stripe Fees | Net Profit  |
| -------------- | ------------ | ------------------ | ------------ | ------------- | ----------------- | ----------- | ----------- |
| 100K traces/mo | $29          | 0                  | $0           | $29.00        | $1.70             | $1.29       | **$26.01**  |
| 250K traces/mo | $29          | 1.5 ($7.50)        | $7.50        | $36.50        | $4.25             | $1.72       | **$30.53**  |
| 500K traces/mo | $29          | 4 ($20)            | $20.00       | $49.00        | $8.50             | $2.19       | **$38.31**  |
| 1M traces/mo   | $29          | 9 ($45)            | $45.00       | $74.00        | $17.00            | $3.94       | **$53.06**  |
| 5M traces/mo   | $29          | 49 ($245)          | $245.00      | $274.00       | $85.00            | $16.64      | **$172.36** |

Heavy users are extremely profitable. A 1M trace/mo org generates $53.06/mo in net profit.

### Passthrough Cost Exposure (Proxy Request Allowance)

Each passthrough costs us ~$0.0015/1K requests ($1.50/million). A proxy request allowance scales with what the user pays:

- **Hobby:** 1.25M requests/mo included (cost to us: $1.88 worst case)
- **Pro base:** 5M requests/mo included (cost to us: $7.50 worst case)
- **Each trace pack ($5/100K):** adds 500K requests to the allowance

| Pro User Profile  | Trace Packs | Total Request Allowance | Max Passthrough Cost |
| ----------------- | ----------- | ----------------------- | -------------------- |
| Light (base only) | 0           | 5M                      | $7.50                |
| Moderate          | 2 ($10)     | 6M                      | $9.00                |
| Heavy             | 10 ($50)    | 10M                     | $15.00               |
| Very heavy        | 50 ($250)   | 30M                     | $45.00               |

At 150% of allowance, the proxy starts returning 429s. This isn't a revenue mechanism -- it's a guardrail that ensures non-paying passthrough usage can't spiral. Any user generating enough requests to hit the limit is almost certainly getting value from traces and should be buying packs.

### Break-Even Analysis

Monthly fixed costs: **$156/mo** (CF Workers $5 + Tinybird Dev 1 $99 + Convex $25 + Sentry $26 + Domain $1)

| Scenario                       | Revenue/mo | Variable Cost | Stripe Fees | Net     | Covers Fixed? |
| ------------------------------ | ---------- | ------------- | ----------- | ------- | ------------- |
| 3 Pro orgs, no packs           | $87        | $5.10         | $3.87       | $78.03  | No (-$78)     |
| 4 Pro orgs, no packs           | $116       | $6.80         | $5.16       | $104.04 | No (-$52)     |
| 5 Pro orgs, no packs           | $145       | $8.50         | $6.45       | $130.05 | No (-$26)     |
| 5 Pro orgs + avg 2 packs each  | $195       | $18.50        | $8.70       | $167.80 | Yes (+$12)    |
| 10 Pro orgs, no packs          | $290       | $17.00        | $12.90      | $260.10 | Yes (+$104)   |
| 10 Pro orgs + avg 2 packs each | $390       | $37.00        | $17.10      | $335.90 | Yes (+$180)   |

**Break-even: ~6 Pro orgs at $29/mo.**

---

## Cost Optimization Opportunities

### High Impact

1. **R2 body compression** -- Gzip request/response bodies before storing. LLM text compresses ~70-80%. Could reduce R2 storage costs by 3-4x and reduce PUT sizes.

2. **R2 Infrequent Access storage class** -- For hobby tier (7-day retention), bodies are rarely re-read. IA storage is $0.01/GB vs $0.015/GB, but Class A ops are $9/M (2x). Only worth it if read ratio is very low.

3. **Keep body writes combined** -- the current implementation already stores request and response in one encrypted R2 object. Recalculate this section before using the old R2 savings model.

4. **Tinybird TTL tuning** -- 90-day TTL on trace data. If hobby gets 7-day body retention, consider shorter Tinybird TTL for hobby (30 days?) to reduce storage.

5. **KV cache hit rate optimization** -- Current two-layer cache (Worker memory 30s + Cache API 60s) reportedly gets 80-90% hit rate. Increasing TTLs to 5 minutes could reduce KV reads by 50%+ with minimal staleness impact.

### Medium Impact

6. **Queue message size optimization** -- Messages >64KB count as multiple operations. Ensure trace payloads are under 64KB to avoid 2x queue charges.

7. **Convex query optimization** -- Dashboard preloads 3-5 queries per page. Consider combining into fewer queries to reduce function call count.

8. **Tinybird plan timing** -- Stay on free tier as long as possible (1,000 queries/day = ~30K dashboard views/month). Only upgrade when QPS or daily query limits are hit.

### Low Impact (Future)

9. **R2 lifecycle policies** -- Automate deletion of expired bodies based on retention tier.

10. **DO hibernation** -- Ensure UsageTracker and TraceBatcher DOs properly hibernate when idle to avoid duration charges.

---

## Optimized Scenario: Backblaze B2 + Combined Bodies

Two changes applied together:

1. **Combined request + response object already shipped** -- current R2 writes are 1 PUT per recorded trace
2. **Swap R2 for Backblaze B2** — $0.40/M PUTs (vs $4.50/M), $0.005/GB storage (vs $0.015/GB), free egress through Cloudflare (Bandwidth Alliance)

Bodies are write-heavy, rarely-read, and always accessed via `waitUntil()` (no user-facing latency). B2's S3-compatible API means the code change is swapping the client endpoint + auth credentials.

### Optimized Per-Trace Breakdown

| Service         | Operation                              | Count/Trace   | Unit Price     | Cost/Trace     | vs Legacy R2       |
| --------------- | -------------------------------------- | ------------- | -------------- | -------------- | ------------------ |
| Workers         | Proxy invocation                       | 1             | $0.30/M        | $0.0000003     |                    |
| Workers         | Consumer invocation                    | 0.1 (batched) | $0.30/M        | $0.00000003    |                    |
| KV              | Reads (auth + billing + pricing)       | 3             | $0.50/M        | $0.0000015     |                    |
| **B2**          | **PUT (combined req+res body)**        | **1**         | **$0.40/M**    | **$0.0000004** | was $0.0000090     |
| **B2**          | **Storage (15KB avg, 30-day)**         | 15KB          | **$0.005/GB**  | **$0.0000001** | was $0.00000023    |
| Queues          | Operations (send + receive)            | 2             | $0.40/M        | $0.0000008     |                    |
| Durable Objects | Requests (UsageTracker + TraceBatcher) | 1.1           | $0.15/M        | $0.00000017    |                    |
| DO SQLite       | Row writes (counters + trace inserts)  | 3             | $1.00/M        | $0.0000030     |                    |
| DO SQLite       | Row reads (config + counters)          | 5             | $0.001/M       | $0.000000005   |                    |
| Tinybird        | Ingestion                              | N/A           | $0 (unlimited) | $0             |                    |
| Tinybird        | Storage (~10KB/trace, 90-day TTL)      | 10KB          | $0.058/GB-mo   | $0.0000006     |                    |
| Convex          | Usage push (amortized)                 | 0.017         | $2.20/M        | $0.00000004    |                    |
| **Total**       |                                        |               |                | **$0.0000069** | **was $0.0000150** |

**Optimized cost: ~$0.007 per 1K traces ($6.90/million).** Down from $0.015/1K — a 54% reduction.

The dominant cost shifts from body storage ops to **DO SQLite writes** (43% of per-trace cost), followed by **KV reads** (22%).

### Optimized User Cost Summary

| User Type    | Traces/mo | Legacy R2 Cost | Optimized Cost | Savings |
| ------------ | --------- | -------------- | -------------- | ------- |
| Hobby        | 25K       | $0.43          | $0.20          | 54%     |
| Moderate Pro | 100K      | $1.68          | $0.78          | 54%     |
| Heavy Pro    | 1M        | $16.87         | $7.77          | 54%     |
| Extreme      | 5M        | $84.31         | $38.81         | 54%     |

### Impact on $30K MRR Scenario (~250M traces/mo)

| Component                | Legacy R2               | Optimized (B2)        | Savings     |
| ------------------------ | ----------------------- | --------------------- | ----------- |
| Body PUTs                | 500M × $4.50/M = $2,250 | 250M × $0.40/M = $100 | **$2,150**  |
| Body Storage (3.75 TB)   | $0.015/GB = $56         | $0.005/GB = $19       | $37         |
| DO SQLite Writes         | $750                    | $750                  | $0          |
| KV Reads                 | $375                    | $375                  | $0          |
| Everything else          | $437                    | $437                  | $0          |
| Tinybird (Dev 1+ovg)     | $99-120                 | $99-120               | $0          |
| **Total infrastructure** | **~$3,900/mo**          | **~$1,710/mo**        | **~$2,190** |
| **Gross margin**         | **87%**                 | **94%**               |             |

### Impact on Unit Economics

| Metric                        | Legacy R2 | Optimized |
| ----------------------------- | --------- | --------- |
| Cost per 1K traces            | $0.017    | $0.007    |
| Pro user variable cost (100K) | $1.68     | $0.78     |
| Net profit per Pro org        | $26.01    | $27.23    |
| Trace pack margin ($5/100K)   | 57%       | 80%       |
| Break-even orgs               | ~6        | ~6        |

Break-even doesn't change much (fixed costs dominate at small scale), but trace pack margins jump from 57% to 80% — making the growth engine significantly more profitable.

### Tradeoffs

- **Added dependency.** B2 is an external service vs R2's native Worker binding. Need S3 auth credentials in env, HTTP calls instead of `env.BUCKET.put()`.
- **Latency.** External HTTP call vs native binding. Irrelevant — bodies are written in `waitUntil()`, never on the user's critical path.
- **Retrieval path.** API worker fetches bodies on dashboard click. B2 GET through Cloudflare is free (Bandwidth Alliance) but adds ~10-50ms vs native R2. Acceptable for on-demand body viewing.
- **Operational complexity.** One more service to monitor, credential rotate, and handle outages for.

---

## Optimized Scenario: DO SQLite Bodies (7-Day Hot Storage)

Store combined request+response bodies in Durable Object SQLite instead of R2. No external dependencies — uses the same DO infrastructure already in the stack. Bodies available instantly via native binding. Default retention: 7 days. Longer retention available as a paid add-on (archive to B2 before expiry).

DO writes ($1.00/M) are 4.5x cheaper than R2 PUTs ($4.50/M). The tradeoff: DO storage ($0.20/GB) is 13x more expensive than R2 ($0.015/GB), but the 7-day retention window keeps total storage small enough that write savings dominate. Cleanup is simple — shard DOs by org+day, delete the whole DO after 7 days.

### Per-Trace Breakdown (DO Bodies)

| Service         | Operation                              | Count/Trace   | Unit Price     | Cost/Trace      | vs Legacy R2       |
| --------------- | -------------------------------------- | ------------- | -------------- | --------------- | ------------------ |
| Workers         | Proxy invocation                       | 1             | $0.30/M        | $0.0000003      |                    |
| Workers         | Consumer invocation                    | 0.1 (batched) | $0.30/M        | $0.00000003     |                    |
| KV              | Reads (auth + billing + pricing)       | 3             | $0.50/M        | $0.0000015      |                    |
| **DO SQLite**   | **Row write (combined req+res body)**  | **1**         | **$1.00/M**    | **$0.0000010**  | was $0.0000090     |
| **DO SQLite**   | **Storage (15KB avg, 7-day rolling)**  | 15KB          | **$0.20/GB**   | **$0.0000007**  | was $0.00000023    |
| **DO**          | **Request (body store)**               | **1**         | **$0.15/M**    | **$0.00000015** | new                |
| Queues          | Operations (send + receive)            | 2             | $0.40/M        | $0.0000008      |                    |
| Durable Objects | Requests (UsageTracker + TraceBatcher) | 1.1           | $0.15/M        | $0.00000017     |                    |
| DO SQLite       | Row writes (counters + trace inserts)  | 3             | $1.00/M        | $0.0000030      |                    |
| DO SQLite       | Row reads (config + counters)          | 5             | $0.001/M       | $0.000000005    |                    |
| Tinybird        | Ingestion                              | N/A           | $0 (unlimited) | $0              |                    |
| Tinybird        | Storage (~10KB/trace, 90-day TTL)      | 10KB          | $0.058/GB-mo   | $0.0000006      |                    |
| Convex          | Usage push (amortized)                 | 0.017         | $2.20/M        | $0.00000004     |                    |
| **Total**       |                                        |               |                | **$0.0000082**  | **was $0.0000150** |

**DO bodies cost: ~$0.008 per 1K traces ($8.20/million).** Down from $0.015/1K — a 45% reduction.

### Scaling Comparison (All Three Options)

| Scale          | Legacy R2 (30-day) | DO SQLite (7-day) | B2 (30-day) |
| -------------- | ------------------ | ----------------- | ----------- |
| 100K traces/mo | $0.92              | $0.15             | $0.06       |
| 1M traces/mo   | $9.23              | $1.75             | $0.12       |
| 5M traces/mo   | $46.13             | $9.38             | $0.62       |
| 50M traces/mo  | $461               | $88               | $12         |
| 250M traces/mo | $2,306             | $438              | $119        |

### Unit Economics (All Three)

| Metric                        | Legacy R2 | DO SQLite (7-day) | B2 (30-day) |
| ----------------------------- | --------- | ----------------- | ----------- |
| Cost per 1K traces            | $0.017    | $0.008            | $0.007      |
| Pro user variable cost (100K) | $1.68     | $0.87             | $0.78       |
| Net profit per Pro org        | $26.01    | $27.14            | $27.23      |
| Trace pack margin ($5/100K)   | 57%       | 77%               | 80%         |

### Recommended Approach: DO Default + B2 Retention Add-On

1. **Launch with DO only.** 7-day body retention, zero external deps, instant reads. No B2 account needed — ship faster.
2. **Add B2 later** as a paid "Extended body retention" add-on (30/60/90-day options). Consumer batch-flushes expiring bodies to B2 before the 7-day TTL. B2 costs are subsidized by the add-on revenue, not base margins.

### Constraints

- **DO SQLite 2MB row limit.** Extended thinking responses or large conversation histories could exceed this. Need to either chunk oversized bodies or truncate with a "body too large" marker.
- **DO 10GB storage limit.** Must shard across DOs (org+day bucketing keeps each DO well under). At 15KB avg, a DO holds ~660K bodies before hitting 10GB.
- **DO storage cost at scale.** If average body sizes are larger than 15KB (unknown — needs measurement), the 13x storage premium over R2 becomes more significant even with 7-day retention.

---

## Service Pricing Reference

Detailed pricing for each service is documented in:

- [Cloudflare Platform Pricing](./cloudflare-pricing.md)
- [Tinybird Pricing](./tinybird-pricing.md)
- [Convex Pricing](./convex-pricing.md)
- [Third-Party Services Pricing](./third-party-pricing.md)
- [Cost Model Blind Spots](./blind-spots.md)
