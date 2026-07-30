# R2 Storage Caps

Status: accepted

Captured: 2026-05-24

Trace Flow stores optional sensitive objects in R2: proxy Body Objects for request/response debugging and explicitly enrolled Pro Conversation Archives. Those objects must be metered per org before write, capped by their product allowance or an explicit operator restriction, and blocked once the org exceeds its live-storage budget. Lifecycle rules and per-object limits remain necessary, but they are not enough to protect the business from abuse or a broken client producing unbounded storage.

## Context

R2 is cheap at normal Trace Flow volumes, but "cheap" is not a control plane. A single org can still create outsized cost by sending huge proxied bodies, repeatedly uploading raw agent transcripts, or running a bug that retries the same large object stream forever. The existing safeguards are partial:

- Proxy Body Objects are truncated per request and expire after 30 days.
- Conversation Archives require Pro Archive Activation and per-Collector Enrollment, use immutable compressed chunks, and have a 100 GB hard cap.
- Agent facts and Tinybird rows are not raw object storage; their retention is governed separately.

Those controls bound individual objects and product scope. They do not by themselves provide strongly consistent enforcement of an org's total live R2 footprint.

## Decision

Introduce one org-scoped storage-budget service across the isolated R2 buckets used by optional raw-object classes. The service owns separate, non-fungible capacity pools:

- the proxy-body pool covers Proxy Body Objects;
- Pro includes a fixed Conversation Archive pool.

Usage in one pool cannot consume capacity in the other. Pro includes 100 GB of archive capacity. v1 has no separate archive purchase or capacity upgrade.

| Object class               | Bucket        | Prefix                                                                                 | Default retention      | Counts toward cap |
| -------------------------- | ------------- | -------------------------------------------------------------------------------------- | ---------------------- | ----------------- |
| Proxy Body Object          | Proxy storage | `bodies/{orgId}/{requestId}`                                                           | 30 days                | yes               |
| Conversation Archive Chunk | Agent Archive | `archive/{orgId}/contributions/{userId}/sessions/{sessionPk}/chunks/{chunkHash}`       | Paid archive retention | yes               |
| Archive Session Manifest   | Agent Archive | `archive/{orgId}/contributions/{userId}/sessions/{sessionPk}/manifests/{manifestHash}` | Paid archive retention | yes               |

The Agent Archive is a dedicated R2 Standard bucket, isolated from Proxy Body Objects and Analyst backups and bound only to Archive API at `archive.trace-flow.dev`. Archive JSONL records are losslessly compressed into immutable Archive Chunks of up to 16 MiB so object-operation cost scales with bytes rather than messages. Chunks and manifests are encrypted with an independent, versioned Archive Encryption Key for their Organization before R2 receives them; provider-managed R2 encryption is an additional layer. Rotation moves new writes to the new key version immediately and re-encrypts existing objects in the background. Chunks are Agent Session and Archive Contribution-scoped: repeated scans deduplicate through the Archive Session Ledger, while physical payloads are never shared across contributors. Organization scoping prevents one tenant from inferring or referencing another tenant's records, while contribution scoping keeps deletion free of shared-object reference counting.

The cap is enforced before every R2 write. The write path asks the storage budget service to reserve the exact proposed R2 object bytes for `(orgId, objectClass, objectKey, expiresAt)`. For an Archive Chunk or manifest, Archive API compresses and encrypts first, then reserves the ciphertext length before `put`; request `Content-Length` is not the metered size. If the reservation would exceed the org's cap, Trace Flow skips the R2 write and records `storage_cap_exceeded` in metadata. If the write succeeds, the reservation is committed; if it fails, the reservation is released.

Proxy-body caps are configurable per org:

- **Plan cap**: included live R2 bytes for the subscription tier.
- **Purchased cap**: additional live bytes bought by the customer.
- **Manual cap**: an operator override for abuse response or negotiated enterprise terms.

The effective cap is the minimum active hard cap when a manual restriction exists; otherwise it is `plan cap + purchased cap`. Operators can lower a manual cap immediately to stop abusive storage growth. Billing can raise purchased cap without redeploying Workers.

The Conversation Archive cap is 100 GB while the Organization has an active Pro entitlement, optionally narrowed by a manual safety cap. It is not increased by the proxy-body plan cap or purchased proxy-body capacity.

### Pro archive allowance economics

At the pricing verified on 2026-07-30, R2 Standard storage costs $0.015 per GB-month, so the 100 GB hard cap costs at most $1.50 per full month. This bounds archive storage safely inside the current $29 Pro price, but it is not a complete unit-economics model for Pro. Trace Flow's current pricing predates the combination of LLM proxying, Agent Conversation Analytics, and Conversation Archive, so broader packaging and pricing are explicitly deferred for redesign.

R2 Infrequent Access could lower stored-byte cost, but retrieval fees make archive export and re-encryption costs usage-dependent. The v1 archive uses Standard storage for a predictable hard ceiling. Packing 100 GB into 16 MiB chunks takes about 6,400 Class A writes, roughly $0.03 at the current $4.50 per million Standard Class A operations before shared free-tier allowances. One-object-per-record storage is prohibited because it would make operation count, not stored bytes, the dominant cost.

Pricing sources:

- <https://developers.cloudflare.com/r2/pricing/>

## Enforcement Semantics

Storage caps block optional sensitive-object storage, not the core product flow.

For proxied LLM Requests:

- The proxy still forwards the request and streams the provider response.
- Trace metadata and usage still enqueue.
- The Body Object is not stored.
- The trace is marked as body omitted with reason `storage_cap_exceeded`.

For Agent Conversation Analytics:

- Parsed facts still enqueue when the request is otherwise valid.
- Conversation Archive chunks and manifests are not acknowledged at the archive cap; the enrolled Collector retains them in its encrypted Archive Spool and shows a blocked archive state.
- Archive upload resumes when capacity returns. Trace Flow never silently drops or automatically evicts archived conversations.

This keeps observability and billing data flowing while cutting off the cost-driving object storage. Request-size limits, rate limits, and abuse controls can still reject the whole request with 413/429 when the traffic itself is unsafe.

## Metering Architecture

Use one Durable Object namespace, `STORAGE_BUDGET`, sharded by `orgId`, as the strongly consistent reservation point. It owns the live-byte ledger for that org:

```typescript
type StorageObjectClass = 'proxy_body' | 'agent_archive_chunk' | 'agent_archive_manifest';

type StorageBudgetEntry = {
  objectKey: string;
  objectClass: StorageObjectClass;
  bytes: number;
  expiresAt: string | null;
  status: 'reserved' | 'committed';
};
```

The reservation API is intentionally small:

```typescript
reserveStorage({
  orgId,
  objectClass,
  objectKey,
  bytes,
  expiresAt,
});

commitStorage({ orgId, objectKey });
releaseStorage({ orgId, objectKey });
getStorageBudget({ orgId });
```

The Durable Object stores both aggregate counters and object entries. Aggregate counters make the hot decision cheap; object entries make expiration, support inspection, and user-facing storage breakdowns possible. Proxy reservations can run inside the existing `waitUntil` persistence path. Archive API does not acknowledge an upload until its reservation, R2 write, and Archive Session Ledger commit are durable. In both paths, the reservation must complete before the R2 `put` begins because the whole point is to stop the write.

## Expiration and Reconciliation

R2 lifecycle deletes do not emit a reliable per-object callback to our Workers, so the storage budget ledger cannot depend on R2 telling us when an object disappeared.

The ledger therefore decrements by declared expiration:

1. Each expiring object records `expiresAt` from the same retention policy used for the R2 lifecycle rule. Active Paid Archive Retention objects have no age-based expiration; cancellation stamps the end of the 90-day frozen grace.
2. A scheduled reconciliation job asks each active org's `STORAGE_BUDGET` Durable Object to expire entries whose non-null `expiresAt` has passed.
3. The job periodically samples or lists R2 prefixes for high-usage orgs and any org whose ledger looks inconsistent, then corrects the ledger if needed.

This is a budget-control ledger, not the source of object truth. R2 remains the object store. The ledger is allowed to be conservative: temporarily over-counting live bytes is acceptable because it blocks new optional object storage; under-counting is not acceptable because it can create unbounded cost.

## Billing and Product Surface

The customer-facing storage state is:

- Current live bytes by object class.
- Included proxy-body cap.
- Purchased proxy-body cap.
- Fixed Pro Conversation Archive cap.
- Manual hard cap, when present.
- First time the org hit `storage_cap_exceeded` in the current billing period.

When an org approaches a cap, the app warns before blocking and identifies the affected capacity pool. Buying more proxy-body capacity or an operator removing a manual restriction makes those writes eligible immediately. The v1 Conversation Archive has no capacity upgrade; its Collector uploads resume only after explicit archive deletion frees capacity or an operator corrects an erroneous restriction. Proxy Body Objects skipped while capped are not backfilled. Archive records remain in the encrypted Archive Spool until acknowledged.

Pro entitlement grants the fixed Conversation Archive capacity. Purchased proxy-body capacity or metered overage remains a separate billing decision that requires explicit customer agreement. Every pool has a hard cap before paid overage exists because the first requirement is protecting Trace Flow from runaway storage cost.

When Pro entitlement ends, archive collection stops and its contents freeze for a 90-day grace period. The Archive Steward may export or restore Pro during grace. Grace expiry destroys the Organization's wrapped Archive Encryption Keys before asynchronous R2 deletion, so no former Pro archive becomes indefinite unpaid storage.

## Interactions With Existing Decisions

This ADR extends, but does not replace:

- [R2 Body Storage](./0008-r2-body-storage.md): Body Objects still live outside Tinybird, still truncate per object, and still expire after 30 days.
- [Agent Conversation Analytics](./0012-agent-conversation-analytics.md): parsed facts do not use R2 transcript storage. Only explicitly enrolled Pro Conversation Archives store Raw Transcripts, under Paid Archive Retention in the isolated Agent Archive bucket.
- [Proxy Transaction Module](./0011-proxy-transaction-module.md): `persistTransaction` remains the owner of side effects. Storage-cap enforcement is policy input to that persistence step, like tier and omit-body decisions.

## Trade-offs

- The hot path adds one strongly consistent budget check before optional R2 writes. We accept that because writes are already off the user-visible critical path where possible, and the check is what prevents unbounded cost.
- The ledger can temporarily block an org even after lifecycle deletion if reconciliation lags. This is safer than temporarily allowing writes that exceed the cap.
- Existing legacy objects under `bodies/{requestId}` are not attributable by prefix. They age out under the existing 30-day lifecycle; new Body Objects use `bodies/{orgId}/{requestId}` so reconciliation and support tooling can reason per org.
- We do not auto-delete old archive objects to make room. The cap blocks new archive writes until the Archive Steward deletes one complete Archive Contribution or the entire Conversation Archive. Proxy Body Objects continue to clear through lifecycle expiration.

## Done

- Proxy Body Object writes reserve against `STORAGE_BUDGET` before R2 `put`; an over-cap org still gets proxied responses and trace metadata, with body storage omitted as `storage_cap_exceeded`.
- Conversation Archive Chunk and manifest writes reserve against `STORAGE_BUDGET`; an over-cap org still ingests parsed facts, while archive writes remain unacknowledged and pending in enrolled Collectors as `storage_cap_exceeded`.
- The budget ledger reports live bytes by object class and enforces separate effective caps for Proxy Body Objects and the fixed Pro Conversation Archive allowance.
- The Conversation Archive allowance is exactly 100 GB for an active Pro Organization, cannot consume or be expanded by proxy-body capacity, and has no customer purchase or upgrade path in v1.
- Repeating an already committed archive upload reuses deterministic Archive Chunk and manifest keys and does not increase live bytes or object count.
- Archive Chunks contain records from one Archive Contribution and Agent Session, are capped at 16 MiB, and never require cross-contributor reference counting or repacking for deletion.
- Expired entries decrement from the ledger through scheduled reconciliation, and high-usage orgs can be checked against R2 prefix inventory.
- Pro loss freezes archive writes for 90 days. Terminal grace expiry destroys all wrapped Archive Encryption Key versions before archive objects and ledger entries are removed.
- New proxy Body Object keys include `orgId` in the prefix; reads remain backward-compatible for legacy `bodies/{requestId}` objects until they age out.
