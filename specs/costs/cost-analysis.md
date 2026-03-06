# Trace Flow Cost Analysis

Last updated: 2026-03-06

## Tech Stack Cost Summary

### Fixed Monthly Costs (Base Fees)

| Service                 | Role                              | Base Cost                |
| ----------------------- | --------------------------------- | ------------------------ |
| Cloudflare Workers Paid | Proxy, Consumer, API, Web runtime | $5/mo                    |
| Tinybird Developer 1    | Trace analytics (ClickHouse)      | $99/mo                   |
| Convex Professional     | Backend DB, auth, billing logic   | $25/dev/mo               |
| Sentry Team             | Error monitoring across 4 workers | $26/mo                   |
| Domain (trace-flow.dev) | DNS                               | ~$1/mo                   |
| **Total fixed**         |                                   | **$156/mo** (single dev) |

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

### Operations Per Recorded Trace (Scenario A)

Full path: Client -> Proxy -> Queue -> Consumer -> Tinybird + R2

| Service         | Operation                              | Count/Trace   | Unit Price (Overage) | Cost/Trace     |
| --------------- | -------------------------------------- | ------------- | -------------------- | -------------- |
| Workers         | Proxy invocation                       | 1             | $0.30/M              | $0.0000003     |
| Workers         | Consumer invocation                    | 0.1 (batched) | $0.30/M              | $0.00000003    |
| KV              | Reads (auth + billing + pricing)       | 3             | $0.50/M              | $0.0000015     |
| R2              | PUTs (request + response body)         | 2             | $4.50/M              | $0.0000090     |
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

The dominant cost driver is **R2 PUT operations** (60% of per-trace cost), followed by **DO SQLite writes** (20%).

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

### Hobby User (50K traces/month)

| Component                             | Usage  | Unit Cost    | Monthly Cost |
| ------------------------------------- | ------ | ------------ | ------------ |
| Worker invocations                    | 55K    | $0.30/M      | $0.02        |
| KV reads                              | 150K   | $0.50/M      | $0.08        |
| R2 PUTs                               | 100K   | $4.50/M      | $0.45        |
| R2 storage (7-day rolling)            | 170 MB | $0.015/GB-mo | $0.003       |
| Queue operations                      | 100K   | $0.40/M      | $0.04        |
| DO requests                           | 55K    | $0.15/M      | $0.01        |
| DO SQLite writes                      | 150K   | $1.00/M      | $0.15        |
| Tinybird storage (90-day rolling)     | 1.5 GB | $0.058/GB-mo | $0.09        |
| Convex calls (usage push + dashboard) | ~3K    | $2.00/M      | $0.01        |
| Dashboard (Convex queries)            | ~500   | $2.00/M      | $0.001       |
| **Total variable cost**               |        |              | **$0.85/mo** |

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
| Hobby        | 50K       | $0.85         | $0.017         |
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
| Tinybird Developer 1                     | $99.00        |
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
| **Total**                                | **~$196/mo**  |
| **Per user**                             | **~$3.93/mo** |
| **Per Pro user (variable only)**         | **~$3.37/mo** |
| **Per Hobby user (variable only)**       | **~$0.85/mo** |

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
| **Per Hobby user (variable only)**         | **~$0.85/mo** |

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

| Component             | Rate         | On $20 subscription |
| --------------------- | ------------ | ------------------- |
| Card processing       | 2.9% + $0.30 | $0.88               |
| Stripe Tax            | 0.5%         | $0.10               |
| **Total Stripe fees** |              | **$0.98 (~4.9%)**   |

For addon packs ($8/100K units):

| Component             | Rate         | On $8 addon       |
| --------------------- | ------------ | ----------------- |
| Card processing       | 2.9% + $0.30 | $0.53             |
| Stripe Tax            | 0.5%         | $0.04             |
| **Total Stripe fees** |              | **$0.57 (~7.1%)** |

Small transactions have disproportionately high Stripe fees due to the $0.30 fixed component.

---

## Key Cost Drivers (Ranked)

At scale, these are the dominant costs:

1. **R2 PUT operations** -- $4.50/M operations, 2 per trace = $9/M traces. This is 60% of per-trace cost. Consider batching or compressing bodies.
2. **Tinybird plan + storage** -- Fixed plan cost ($99-299) + storage grows with retention. At 90-day TTL, storage accumulates 3x monthly ingestion.
3. **KV reads** -- $0.50/M, 2-3 per request. The two-layer cache helps but every cache miss hits KV. At scale this adds up.
4. **Convex plan** -- $25/dev/mo is a fixed cost that kicks in once you exceed free tier limits.
5. **DO SQLite writes** -- $1.00/M, 3 per trace. Small but grows linearly.
6. **Queue operations** -- $0.40/M, 2 per trace. Cheap but adds up.

---

## Pricing Recommendations

### Proposed Tiers

#### Hobby (Free)

- **Price:** $0
- **Included traces:** 50,000/month per org
- **Seats:** 1
- **Retention:** 7 days (R2 bodies), 90 days (Tinybird analytics)
- **Overage:** Hard blocked -- no trace packs available
- **Our variable cost:** $0.85/mo

Purpose: acquisition funnel. 50K traces is generous compared to competitors (LangSmith: 5K, Helicone: 10K). Enough to properly evaluate the product with real workloads, not enough to run production on.

#### Pro ($20/seat/month)

- **Price:** $20/seat/month
- **Included traces:** 100,000/month per org (flat, not per-seat)
- **Seats:** Unlimited (billed per seat)
- **Retention:** 30 days (R2 bodies), 90 days (Tinybird analytics)
- **Overage:** Trace packs (see below), auto-topup available
- **Our variable cost for included traces:** $1.70/mo

Why $20:

- Market rate: LangSmith is $39/seat, Helicone is $20/seat. $20 positions us as accessible without being "cheap."
- At $20, net after Stripe (2.9% + $0.30 + 0.5% tax) is **$18.82/seat**.
- After subtracting the $1.70 variable cost for 100K included traces: **$17.12 net margin/seat** (86%).
- Single-seat org covers its own fixed cost share and then some.

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
| 100K traces/mo | $20          | 0                  | $0           | $20.00        | $1.70             | $0.98       | **$17.32**  |
| 250K traces/mo | $20          | 1.5 ($7.50)        | $7.50        | $27.50        | $4.25             | $1.48       | **$21.77**  |
| 500K traces/mo | $20          | 4 ($20)            | $20.00       | $40.00        | $8.50             | $2.48       | **$29.02**  |
| 1M traces/mo   | $20          | 9 ($45)            | $45.00       | $65.00        | $17.00            | $4.49       | **$43.51**  |
| 5M traces/mo   | $20          | 49 ($245)          | $245.00      | $265.00       | $85.00            | $17.39      | **$162.61** |

Heavy users are extremely profitable. A 1M trace/mo user generates $43.51/mo in net profit from a single seat.

### Passthrough Cost Exposure (Proxy Request Allowance)

Each passthrough costs us ~$0.0015/1K requests ($1.50/million). A proxy request allowance scales with what the user pays:

- **Hobby:** 2.5M requests/mo included (cost to us: $3.75 worst case)
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

Monthly fixed costs: **$156/mo** (CF Workers $5 + Tinybird $99 + Convex $25 + Sentry $26 + Domain $1)

| Scenario                        | Revenue/mo | Variable Cost | Stripe Fees | Net     | Covers Fixed? |
| ------------------------------- | ---------- | ------------- | ----------- | ------- | ------------- |
| 5 Pro seats, no packs           | $100       | $8.50         | $4.90       | $86.60  | No (-$69)     |
| 8 Pro seats, no packs           | $160       | $13.60        | $7.84       | $138.56 | No (-$17)     |
| 10 Pro seats, no packs          | $200       | $17.00        | $9.80       | $173.20 | Yes (+$17)    |
| 5 Pro seats + avg 2 packs each  | $150       | $18.50        | $7.15       | $124.35 | No (-$32)     |
| 10 Pro seats + avg 2 packs each | $300       | $37.00        | $14.30      | $248.70 | Yes (+$93)    |

**Break-even: ~10 Pro seats at $20/mo** assuming moderate trace pack revenue. With active trace pack buyers, it drops to ~8 seats.

---

## Cost Optimization Opportunities

### High Impact

1. **R2 body compression** -- Gzip request/response bodies before storing. LLM text compresses ~70-80%. Could reduce R2 storage costs by 3-4x and reduce PUT sizes.

2. **R2 Infrequent Access storage class** -- For hobby tier (7-day retention), bodies are rarely re-read. IA storage is $0.01/GB vs $0.015/GB, but Class A ops are $9/M (2x). Only worth it if read ratio is very low.

3. **Batch R2 writes** -- Currently 2 PUTs per trace (request + response separately). Could combine into a single PUT with a delimiter, cutting R2 Class A costs by 50% ($4.50/M saved per M traces).

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

## Service Pricing Reference

Detailed pricing for each service is documented in:

- [Cloudflare Platform Pricing](./cloudflare-pricing.md)
- [Tinybird Pricing](./tinybird-pricing.md)
- [Convex Pricing](./convex-pricing.md)
- [Third-Party Services Pricing](./third-party-pricing.md)
