# Proxy KV Caching: Two-Layer Cache for Cost Control

## Decision

Add a two-layer cache (L1 module-scope Map + L2 Cloudflare Cache API) in front of KV reads and Durable Object calls in the proxy worker. This eliminates 99%+ of billable KV reads and DO requests for repeat traffic.

## Context

The proxy worker sits in the hot path of every LLM request. Even when a customer exceeds their trace quota, the proxy still handles the request — it forwards to the LLM provider and streams back the response, just without storing the trace. This is by design: we never break the customer's LLM integration, we only skip observability.

The problem is that every request — traced or not — incurs billable Cloudflare operations before the tracing decision is made:

| Step                 | Resource | Code Location                               |
| -------------------- | -------- | ------------------------------------------- |
| API key validation   | KV read  | `auth.ts:30` — `API_KEYS.get(apiKey)`       |
| Billing status check | KV read  | `auth.ts:80` — `API_KEYS.get(sub:${orgId})` |
| Usage quota check    | DO call  | `usage.ts:38-46` — `USAGE_TRACKER`          |

For a customer sending 10M requests/month (but only tracing 50k), these 3 operations per request dominate infrastructure cost.

### Cloudflare Billing Model

**KV reads are billed per `.get()` call**, even when served from KV's internal edge cache. The `cacheTtl` parameter on `KV.get()` improves read latency but does NOT reduce billing — every call is metered. This is the single most important billing fact driving this decision.

- KV reads: **$0.50 per million** (100k/day free on paid plan)
- DO requests: **$0.15 per million** (1M/month free)
- Worker invocations: **$0.30 per million** (10M/month free on $5 base)
- Egress bandwidth: **Free** on CF Workers

### Cost Without Caching

For one customer sending 10M requests/month on a $29/org/month plan:

| Resource             | Quantity        | Cost                      |
| -------------------- | --------------- | ------------------------- |
| Worker invocations   | 10M             | ~$0 (included in $5 base) |
| KV reads             | 20M (2/request) | $10.00                    |
| DO requests          | ~10M            | $1.35                     |
| R2 PUTs (50k traces) | 100k            | $0.45                     |
| Queue messages (50k) | 50k             | $0.02                     |
| **Total**            |                 | **~$11.82**               |

Revenue: $29. Margin: ~$17 (59%). That's before Tinybird, Convex, R2 storage, or any other costs.

At 10 customers x 10M requests each: $152 cost against $290 revenue (48% margin). Still tight after other costs.

### Cost With Two-Layer Caching

| Resource                | Quantity | Cost       |
| ----------------------- | -------- | ---------- |
| Worker invocations      | 10M      | ~$0        |
| KV reads (cached)       | ~100k    | $0.05      |
| DO requests (cached)    | ~50k     | $0.007     |
| R2 + Queue (50k traces) | 100k/50k | $0.47      |
| **Total**               |          | **~$0.53** |

Revenue: $29. Margin: $28.47 (98%).

## Caching Architecture

### Layer 1: Module-Scope Map

Cloudflare Workers reuse V8 isolates across requests within the same data center. A `Map` declared at module scope persists for the isolate's lifetime. Reads from this cache have zero I/O cost and zero billing impact.

Isolates are evicted unpredictably (resource pressure, deploys, low traffic), so L1 is unreliable as a sole cache. But for burst traffic (multiple requests per second from the same customer), the L1 hit rate is >95%.

### Layer 2: Cloudflare Cache API

`caches.default` is the Workers Cache API. It has no per-operation billing. It's local to the data center (not globally replicated like KV), ephemeral (can be evicted), and survives isolate recycling. This catches the misses that occur when an isolate is recycled but the request is still hitting the same colo.

The Cache API stores Request/Response pairs. To cache a KV value, we construct a synthetic `Request` with a deterministic URL as the key and store the JSON value in a `Response` body with `Cache-Control: max-age={ttl}`.

### Read Path

```
1. Check L1 (Map) → hit? return immediately       [zero I/O, zero cost]
2. Check L2 (Cache API) → hit? populate L1, return [no KV read billed]
3. Read from KV → populate L1 + L2, return         [1 billed KV read]
```

### What We Cache

| Value                                         | TTL | Rationale                                   |
| --------------------------------------------- | --- | ------------------------------------------- |
| API key data (`API_KEYS.get(apiKey)`)         | 60s | Rarely changes; revocation delay acceptable |
| Billing status (`API_KEYS.get(sub:${orgId})`) | 60s | Changes on subscription updates only        |
| Usage exceeded result (DO `exceeded`/`error`) | 60s | Terminal state; no counting needed          |

### What We Do NOT Cache

**`allowed` usage results must never be cached.** The DO call for `checkUsage()` serves two purposes: (1) check if quota is exceeded, and (2) increment the usage counter. Caching `allowed` would skip the counter increment, causing quota tracking to break. Only terminal states (`exceeded`, `error`, `billing_not_active`) are safe to cache because they don't need counter increments.

## Trade-offs

| Risk                                                       | Impact                                                                         | Mitigation                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Revoked API key accepted for up to 60s                     | Low — attacker would need the key AND there's a window                         | 60s is standard for edge caching; keys can also be blocked at provider level |
| Billing status change takes 60s to propagate               | Negligible — subscription changes are rare and the delay is invisible to users | Could add cache-busting header for explicit invalidation                     |
| Exceeded user gets 60s of DO calls before caching kicks in | Minimal cost (~$0.15/M) during the window before "exceeded" is cached          | First exceeded response caches immediately                                   |
| Isolate recycling reduces L1 effectiveness                 | L2 (Cache API) catches the miss within the same colo                           | Two-layer design specifically addresses this                                 |
| Cache API eviction                                         | Falls through to KV correctly; just costs one billed read                      | Graceful degradation by design                                               |
| Module-scope Map unbounded growth                          | Memory pressure could evict isolate                                            | Evict expired entries on read; cap Map at 1000 entries                       |

## Verification

1. **Cache hit tracking**: Add `X-Trace-Flow-Cache` response header during development (`l1-hit`, `l2-hit`, `kv-read`) to verify cache layers are working
2. **KV read metrics**: Compare KV read counts in CF dashboard before and after deployment
3. **Load test**: `wrk -t4 -c100 -d30s` against proxy endpoint; KV reads should stay flat regardless of request volume
4. **Key revocation**: Revoke an API key, verify it's rejected within 60 seconds
5. **Quota counting**: Send requests within quota, verify DO counter increments correctly (not cached)
6. **Quota exceeded**: Exhaust quota, verify subsequent requests get cached `exceeded` response without DO calls
7. **Quota refill**: Purchase additional quota after exceeding, verify it takes effect within 60s
8. **Existing test suite**: All proxy tests must pass unchanged

## Sources

- [Workers KV Pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [How KV Works](https://developers.cloudflare.com/kv/concepts/how-kv-works/) — edge caching behavior, cacheTtl
- [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) — free, per-colo, ephemeral
- [How Workers Works](https://developers.cloudflare.com/workers/reference/how-workers-works/) — isolate reuse across requests
- [Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) — global scope guidance
