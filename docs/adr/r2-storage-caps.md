# R2 Storage Caps

Status: accepted

Captured: 2026-05-24

Trace Flow stores optional raw objects in R2: proxy Body Objects for request/response debugging and agent raw transcripts for replay/deep analysis. Those objects must be metered per org before write, capped by plan or an explicit billing override, and blocked once the org exceeds its live-storage budget. Lifecycle rules and per-object truncation remain necessary, but they are not enough to protect the business from abuse or a broken client producing unbounded storage.

## Context

R2 is cheap at normal Trace Flow volumes, but "cheap" is not a control plane. A single org can still create outsized cost by sending huge proxied bodies, repeatedly uploading raw agent transcripts, or running a bug that retries the same large object stream forever. The existing safeguards are partial:

- Proxy Body Objects are truncated per request and expire after 30 days.
- Agent raw transcripts are opt-in, gzip-compressed, and expire after 90 days.
- Agent facts and Tinybird rows are not raw object storage; their retention is governed separately.

Those controls bound individual objects and age. They do not bound an org's total live R2 footprint, nor do they provide a billing hook for orgs that intentionally need more storage.

## Decision

Introduce a shared org-scoped Storage Budget for all optional raw-object classes:

| Object class         | Prefix                                                       | Default retention | Counts toward cap |
| -------------------- | ------------------------------------------------------------ | ----------------: | ----------------- |
| Proxy Body Object    | `bodies/{orgId}/{requestId}`                                 |           30 days | yes               |
| Agent Raw Transcript | `agent-transcripts/{orgId}/{session_pk}/latest.jsonl.gz.enc` |           90 days | yes               |

The cap is enforced before every R2 write. The write path asks the storage budget service to reserve `contentLength` bytes for `(orgId, objectClass, objectKey, expiresAt)`. If the reservation would exceed the org's cap, Trace Flow skips the R2 write and records `storage_cap_exceeded` in metadata. If the write succeeds, the reservation is committed; if it fails, the reservation is released.

Caps are configurable per org:

- **Plan cap**: included live R2 bytes for the subscription tier.
- **Purchased cap**: additional live bytes bought by the customer.
- **Manual cap**: an operator override for abuse response or negotiated enterprise terms.

The effective cap is the minimum active hard cap when a manual restriction exists; otherwise it is `plan cap + purchased cap`. Operators can lower a manual cap immediately to stop abusive storage growth. Billing can raise purchased cap without redeploying Workers.

## Enforcement Semantics

Storage caps block optional raw storage, not the core product flow.

For proxied LLM Requests:

- The proxy still forwards the request and streams the provider response.
- Trace metadata and usage still enqueue.
- The Body Object is not stored.
- The trace is marked as body omitted with reason `storage_cap_exceeded`.

For agent ingest:

- Parsed facts still enqueue when the request is otherwise valid.
- The raw transcript object is not stored.
- Replay/deep-analysis capability is unavailable for that session unless the user re-syncs after storage is available.
- The ingest response reports raw storage as skipped, not as a full ingest failure.

This keeps observability and billing data flowing while cutting off the cost-driving object storage. Request-size limits, rate limits, and abuse controls can still reject the whole request with 413/429 when the traffic itself is unsafe.

## Metering Architecture

Use one Durable Object namespace, `STORAGE_BUDGET`, sharded by `orgId`, as the strongly consistent reservation point. It owns the live-byte ledger for that org:

```typescript
type StorageObjectClass = 'proxy_body' | 'agent_raw_transcript';

type StorageBudgetEntry = {
  objectKey: string;
  objectClass: StorageObjectClass;
  bytes: number;
  expiresAt: string;
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

The Durable Object stores both aggregate counters and object entries. Aggregate counters make the hot decision cheap; object entries make expiration, support inspection, and user-facing storage breakdowns possible. Calls from the proxy and agent ingest Workers are in `waitUntil` paths where possible, but the reservation must complete before the R2 `put` begins because the whole point is to stop the write.

## Expiration and Reconciliation

R2 lifecycle deletes do not emit a reliable per-object callback to our Workers, so the storage budget ledger cannot depend on R2 telling us when an object disappeared.

The ledger therefore decrements by declared expiration:

1. Each committed object records `expiresAt` from the same retention policy used for the R2 lifecycle rule.
2. A scheduled reconciliation job asks each active org's `STORAGE_BUDGET` Durable Object to expire entries whose `expiresAt` has passed.
3. The job periodically samples or lists R2 prefixes for high-usage orgs and any org whose ledger looks inconsistent, then corrects the ledger if needed.

This is a budget-control ledger, not the source of object truth. R2 remains the object store. The ledger is allowed to be conservative: temporarily over-counting live bytes is acceptable because it blocks new optional raw storage; under-counting is not acceptable because it can create unbounded cost.

## Billing and Product Surface

The customer-facing storage state is:

- Current live bytes by object class.
- Included cap.
- Purchased cap.
- Manual hard cap, when present.
- First time the org hit `storage_cap_exceeded` in the current billing period.

When an org approaches the cap, the app warns before blocking. Once blocked, the app explains which optional storage stopped: proxy bodies, agent raw transcripts, or both. Buying more storage or an operator removing a manual cap makes new writes eligible immediately; objects skipped while capped are not backfilled automatically unless the source can re-send them.

Billing should charge for purchased storage capacity or for metered overage only after an explicit customer agreement. The hard cap exists even before paid overage exists, because the first requirement is protecting Trace Flow from runaway storage cost.

## Interactions With Existing Decisions

This ADR extends, but does not replace:

- [R2 Body Storage](./r2-body-storage.md): Body Objects still live outside Tinybird, still truncate per object, and still expire after 30 days.
- [Agent Conversation Analytics](./agent-conversation-analytics.md): Raw transcript upload remains opt-in and 90-day bounded, but now also consumes the shared org Storage Budget.
- [Proxy Transaction Module](./proxy-transaction-module.md): `persistTransaction` remains the owner of side effects. Storage-cap enforcement is policy input to that persistence step, like tier and omit-body decisions.

## Trade-offs

- The hot path adds one strongly consistent budget check before optional R2 writes. We accept that because writes are already off the user-visible critical path where possible, and the check is what prevents unbounded cost.
- The ledger can temporarily block an org even after lifecycle deletion if reconciliation lags. This is safer than temporarily allowing writes that exceed the cap.
- Existing legacy objects under `bodies/{requestId}` are not attributable by prefix. They age out under the existing 30-day lifecycle; new Body Objects use `bodies/{orgId}/{requestId}` so reconciliation and support tooling can reason per org.
- We do not auto-delete old objects to make room in v1. A cap blocks new optional raw storage; lifecycle clears old objects naturally. Explicit user deletion can be added later.

## Done

- Proxy Body Object writes reserve against `STORAGE_BUDGET` before R2 `put`; an over-cap org still gets proxied responses and trace metadata, with body storage omitted as `storage_cap_exceeded`.
- Agent raw transcript writes reserve against the same `STORAGE_BUDGET`; an over-cap org still ingests parsed facts, with raw storage skipped as `storage_cap_exceeded`.
- The budget ledger reports live bytes by object class and enforces the effective cap from plan, purchased capacity, and manual operator override.
- Expired entries decrement from the ledger through scheduled reconciliation, and high-usage orgs can be checked against R2 prefix inventory.
- New proxy Body Object keys include `orgId` in the prefix; reads remain backward-compatible for legacy `bodies/{requestId}` objects until they age out.
