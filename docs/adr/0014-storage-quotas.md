# Storage Quotas and Overage Protection

Status: superseded by [R2 Storage Caps](./0013-r2-storage-caps.md)

Captured: 2026-05-24

This draft is retained only as historical context. Do not implement the monthly KV-counter quota model or the Agent Ingest transcript path below. The accepted decisions are [R2 Storage Caps](./0013-r2-storage-caps.md), which uses a live-byte Storage Budget and strongly consistent Durable Object reservations, and [Agent Conversation Analytics](./0012-agent-conversation-analytics.md), which gives explicitly enrolled Pro Conversation Archives a separate Archive API, dedicated R2 bucket, and fixed 100 GB capacity.

## Decision

Implement per-org storage quotas for R2 data (proxy bodies and agent transcripts). Quotas are tier-based, soft-capped with warnings, hard-capped with rejection. Overage charges are tracked and billed separately. Quota enforcement happens at ingest time in the Proxy and Agent Ingest Workers.

## Context

Two features store unbounded data in R2:

1. **Proxy bodies** (`bodies/{requestId}`): Optional capture of LLM request/response bodies, 30-day lifecycle. Average ~20KB per request.
2. **Agent transcripts** (`agent-transcripts/{orgId}/{session_pk}`): Opt-in raw conversation dumps, 90-day lifecycle, gzip-compressed at ~10x ratio on raw size.

Both are triggered by org-scoped features (proxy body capture toggle, agent transcript upload opt-in), so an org controls its own storage. But storage can grow unbounded:

- A heavy user with high request volume (1000s/day) can accumulate gigabytes in proxy bodies alone.
- An agent session with thousands of turns, repeated across many concurrent sessions, can produce multi-gigabyte compressed transcripts.
- Accidental or malicious uploads (e.g., loops uploading duplicate sessions, oversized transcripts) can spike costs quickly.

Without quotas, a runaway ingest could cost hundreds or thousands per month. With quotas, we:

- Prevent cost surprises and unexpected bills
- Stop abuse/misuse at the source (reject before storing)
- Stay within budget/SLA guarantees
- Give customers confidence in billing predictability

## Design

### Quota Tiers

Quotas are tied to account tier (hobby, pro, enterprise):

| Tier       | Monthly Quota | Soft Cap | Hard Cap | Notes                                   |
| ---------- | ------------- | -------- | -------- | --------------------------------------- |
| Hobby      | 10 GB         | 9 GB     | 10 GB    | 10 GB covers ~500k small requests/month |
| Pro        | 100 GB        | 90 GB    | 100 GB   | 100 GB ~5M requests/month               |
| Enterprise | Custom        | 90% mark | Hard cap | Negotiated per contract                 |

Quotas reset on the 1st of each calendar month (UTC).

Soft and hard caps are measured against current month's storage _starting fresh_ each month, not rolling 30/90-day windows. This aligns billing cycles and makes quotas predictable.

### Enforcement Points

#### Proxy Worker (Body Capture)

When a request completes and the proxy prepares to store the body:

```typescript
const orgQuotaUsage = await getOrgStorageUsage(orgId, currentMonth);
const bodySize = estimateSize(bodyKey, payload);

if (orgQuotaUsage.bytes + bodySize > quota.hardCap) {
  logMetric('storage.quota.exceeded', { orgId, tier });
  return 413; // Payload Too Large
}

if (orgQuotaUsage.bytes + bodySize > quota.softCap && !softCapWarned) {
  logMetric('storage.quota.warning', { orgId, usage: orgQuotaUsage.bytes, tier });
  addBillingFlag(orgId, 'storage_soft_cap_warning');
}

// Proceed with storage
await storage.put(bodyKey, payload, { customMetadata: { orgId } });
```

Storage is **rejected at the hard cap**; soft cap is a **warning/alert signal** for billing and customer success to proactively reach out.

#### Agent Ingest Worker (Transcript Upload)

When the Collector uploads a raw transcript:

```typescript
const orgQuotaUsage = await getOrgStorageUsage(orgId, currentMonth);
const rawSize = request.headers.get('content-length');

if (orgQuotaUsage.bytes + rawSize > quota.hardCap) {
  logMetric('agent.storage.quota.exceeded', { orgId });
  return 413;
}

if (orgQuotaUsage.bytes + rawSize > quota.softCap) {
  addBillingFlag(orgId, 'agent_storage_soft_cap_warning');
}

// Encrypt and store to R2
const encryptedData = await encryptWithTenantKey(orgId, gzipData);
await agentStorage.put(`agent-transcripts/${orgId}/${sessionPk}`, encryptedData, {
  customMetadata: { orgId, sessionPk, compressedSize: rawSize },
});
```

Same contract: hard cap rejects, soft cap alerts.

### Usage Tracking

#### In-Memory Cache (Per Worker Instance)

Each Worker instance maintains a in-memory cache of current month's usage by org:

```typescript
// Expires at end of month (UTC)
const quotaCache = new Map<string, { bytes: number; updatedAt: Date }>();

async function getOrgStorageUsage(
  orgId: string,
  month: Date,
): Promise<{ bytes: number; updatedAt: Date }> {
  if (isNewMonth(quotaCache, month)) {
    quotaCache.clear();
  }

  if (quotaCache.has(orgId)) {
    return quotaCache.get(orgId);
  }

  // Fetch from authoritative source (KV or Tinybird)
  const bytes = await fetchMonthlyUsage(orgId, month);
  quotaCache.set(orgId, { bytes, updatedAt: new Date() });
  return { bytes, updatedAt: new Date() };
}
```

Cache lookups are fast (in-process), and the cost of a miss is one KV read per org per Worker activation. Cache is flushed at month boundary to avoid stale data.

#### Authoritative Record (KV)

Cloudflare KV holds the month-to-date cumulative bytes per org:

```text
trace-flow:quota:usage:{orgId}:{YYYYMM} = "{bytes: number, lastUpdatedAt: ISO8601}"
```

On each storage operation, increment atomically:

```typescript
const key = `trace-flow:quota:usage:${orgId}:${YYYYMM}`;
const current = await KV.get(key);
const bytes = current ? JSON.parse(current).bytes : 0;
const updated = { bytes: bytes + storageBytes, lastUpdatedAt: new Date().toISOString() };
await KV.put(key, JSON.stringify(updated));
```

KV is the source of truth; Worker cache is a performance optimization.

### Billing and Overage

#### Hard Cap (Rejection)

When hard cap is hit, the request returns 413. The Collector/client can:

1. Retry (if it's a transient failure)
2. Upgrade tier (if quota is genuinely too small)
3. Wait for month boundary (if quota resets)
4. Reduce storage usage (delete old transcripts, disable body capture)

Overage beyond the cap is **not** charged; it's **prevented**. This is a hard fence.

#### Soft Cap (Overage Billing)

When soft cap is breached, storage is accepted but the org is flagged for billing:

```typescript
interface OrgBillingFlags {
  storage_soft_cap_warning?: { flaggedAt: ISO8601; thresholdBreached: number };
  storage_overage_usage?: { month: YYYYMM; bytes: number; chargedAt?: ISO8601 };
}
```

At month-end, billing calculates overage:

```text
overage_bytes = max(0, totalUsage - softCap)
overage_cost = overage_bytes * OVERAGE_RATE

// $0.025 per GB (above soft cap, below hard cap)
const OVERAGE_RATE = 0.025 / (1024 * 1024 * 1024);
```

Overage is added to the month's invoice as a line item. It's charged at a premium to discourage it but is not a hard blocker (soft cap exists for early warning).

The hard cap prevents truly unbounded spend; overage charges discourage careless usage.

#### Communication

When soft cap is first breached:

- Log to Axiom for team alerts
- Add flag to org's billing record (visible in admin panel)
- Convex action fires (or weekly job) to notify org owners via email: "Your storage usage is above plan limit. Please review and upgrade or reduce usage."

### Quota Adjustment

#### Tier Upgrades

When an org upgrades from Hobby to Pro:

1. Old quota usage carries forward (not erased)
2. New quota limit applies immediately
3. Example: Hobby org at 9.5 GB upgrades to Pro; they see new 100 GB hard cap, existing 9.5 GB counts toward it.

#### Manual Override (Support)

Support can override quotas for Enterprise orgs or special cases:

```typescript
// In Convex action (admin-only)
async function overrideOrgQuota(orgId: string, customHardCap: number) {
  await db.insert('orgQuotaOverrides', {
    orgId,
    hardCapBytes: customHardCap,
    softCapBytes: customHardCap * 0.9,
    appliedAt: new Date(),
    appliedBy: auth.user.email,
  });
}
```

A read path checks overrides before applying default tier quotas.

### Monitoring and Alerts

#### Metrics

Log to Axiom/Prometheus:

- `storage.quota.usage` — current usage by org/tier (gauge)
- `storage.quota.warning` — soft cap breached (counter)
- `storage.quota.exceeded` — hard cap hit, request rejected (counter)
- `agent.storage.quota.usage` — transcript storage by org (gauge)

Dashboards track:

- Top orgs by storage % of quota
- Orgs above soft cap (alert threshold)
- Daily quota rejections (hard cap hits)

#### Alerts

- **Storage near cap** (soft): Team notification in #observability (daily summary of orgs above soft cap)
- **Quota rejection** (hard): Alert per 10 rejections in 5 min from same org (abuse signal)

### No Backfill for Existing Users

Existing storage is **not** counted retroactively against quotas. Quotas apply to new storage only (starting 2026-06-01 or deploy date). This avoids surprising existing orgs with bills for past usage they couldn't have known was metered.

However, existing orgs see their current usage in the admin panel, so they can prepare for the quota enforced on day one.

### Known Limitations

- **Per-org granularity only**: No per-user or per-project sub-quotas within an org. An org controls its own ceiling; power users within an org who consume disproportionately are a known limitation.
- **Calendar month boundary**: Quotas reset monthly. An org that exhausts quota on the 28th has to wait 2–3 days. No daily or weekly reset.
- **No refunds for overage**: If an org breaches soft cap and gets charged, overage charges are not refunded even if they immediately delete data. The charge stands to discourage careless behavior.
- **Compressed vs uncompressed**: Agent transcript size is tracked as gzip-compressed size (what lands in R2). Raw size is not tracked, so re-compression from a larger raw is not a quota concern.

## Trade-offs

- **Tight coupling to tier**: Quotas are fixed per tier, not per-org customizable (except via support override). A Pro org with unusual needs might hit the cap and need to request override. Manual override is the relief valve.
- **Per-request checks**: Every write calls `getOrgStorageUsage()`, which requires a KV read if cache misses. At high request volume (10k/min), this could be a bottleneck. In-memory cache mitigates but requires month-boundary awareness.
- **Estimated size**: The proxy estimates body size as `JSON.stringify()` length + overhead, not exact R2 object size. Gzip and R2 metadata can alter actual size. The estimate is conservative to avoid overshooting.
- **Eventual consistency**: KV updates are eventually consistent. A burst of writes in the same second could briefly over-report usage, but KV is consistent within milliseconds on a single region.

## Deferred

- Daily quota resets (weekly/daily cycles are more complex; monthly aligns with billing).
- Per-project quotas (org-level is first-class; sub-quotas deferred).
- Quota warnings via in-app UI (alerts go to Axiom/email; dashboards added later).
- Discount tiers for high-volume usage (first iteration is simple overage pricing; tiered pricing deferred).

## Done

- [ ] Proxy Worker checks hard cap before storing bodies; rejects 413 if exceeded.
- [ ] Proxy Worker logs soft cap breach to Axiom, flags org for billing.
- [ ] Agent Ingest Worker enforces same hard/soft cap checks for raw transcripts.
- [ ] KV-backed usage tracker (monthly per org).
- [ ] Monthly quota resets; old months' usage does not roll forward.
- [ ] Soft cap sends email notification to org owners.
- [ ] Hard cap returns 413; Collector handles gracefully (retries, warns user).
- [ ] Billing calculates overage at month-end ($0.025/GB above soft cap).
- [ ] Support can override quotas via Convex admin action.
- [ ] Dashboards show quota usage by org, soft/hard cap breaches.
- [ ] Alerts fire for orgs above soft cap and for quota rejection spikes.
- [ ] Existing storage as of deploy date is not backfilled; quotas apply to new storage only.
- [ ] Month boundary and tier-upgrade scenarios are tested.
