# R2 Body Storage: Separate Storage for Request/Response Bodies

## Decision

Request and response bodies are stored in Cloudflare R2, not in the queue message or Tinybird datasource. Queue messages contain R2 keys that reference the stored bodies.

## Context

LLM requests and responses can be large. A conversation with long context might send 50KB of messages. A response with reasoning traces or long-form content might return 100KB or more. Image inputs and tool call sequences can reach megabytes.

We need to:

1. Store bodies for debugging and replay
2. Keep queue messages lightweight
3. Avoid bloating the analytics datasource
4. Enable flexible retention policies

## Size Constraints That Drove This Decision

### Cloudflare Queues: 128KB Message Limit

Queue messages have a hard 128KB limit. A single LLM response can exceed this:

```json
{
  "choices": [
    {
      "message": {
        "content": "... 100KB of reasoning and response ..."
      }
    }
  ],
  "usage": { "prompt_tokens": 5000, "completion_tokens": 10000 }
}
```

Embedding bodies in queue messages would fail for many real-world requests.

### Tinybird Row Size Limits

Tinybird (ClickHouse) can store large strings, but it's optimized for analytics, not document storage. Large text columns:

- Slow down aggregation queries
- Increase storage costs significantly
- Make backups and exports unwieldy
- Complicate schema migrations

Storing multi-megabyte bodies in every row would bloat a datasource designed for time-series analytics.

### Memory Constraints

Workers have 128MB memory limits. Holding multiple large bodies in memory during queue processing risks OOM errors. By storing bodies in R2 immediately, the proxy releases memory before sending the queue message.

## How It Works

### Proxy Worker: Store Once

The proxy stores bodies immediately after capture:

```typescript
const bodyKey = `bodies/${orgId}/${requestId}`;
const payload = JSON.stringify({
  requestBody,
  responseBody,
  truncated,
});
const payloadBytes = new TextEncoder().encode(payload).byteLength;

const reservation = await storageBudget.reserveStorage({
  orgId,
  objectClass: 'proxy_body',
  objectKey: bodyKey,
  bytes: payloadBytes,
  expiresAt,
});

if (!reservation.allowed) {
  return { bodyKey, stored: false, reason: 'storage_cap_exceeded' };
}

await storage.put(bodyKey, payload, {
  customMetadata: { orgId },
  httpMetadata: { contentType: 'application/json' },
});
await storageBudget.commitStorage({ orgId, objectKey: bodyKey });
```

This reduces body storage from two Class A operations to one. The queue message is still under 1KB because it contains metadata, not raw bodies.

### API Worker: Retrieve on Demand

The web UI fetches the combined payload through the API worker:

```typescript
app.get('/bodies/:requestId', async (c) => {
  const object = await c.env.STORAGE.get(`bodies/${requestId}`);
  return c.json(await object.json());
});
```

Bodies are fetched only when users expand trace details, not during initial page load. Each detail view now requires one API request and one R2 read instead of separate request/response fetches.

## R2 Key Naming Convention

Keys follow a predictable pattern:

```
bodies/{orgId}/{requestId}
```

Where `orgId` is the owning organization and `requestId` is a unique identifier generated per request (UUID format). Legacy objects under `bodies/{requestId}` remain readable until they age out, but new objects include `orgId` so storage-budget reconciliation and support tooling can reason per org.

This structure provides:

- **Simple lookups**: Given an orgId and requestId, construct one key
- **Org attribution**: Prefix scans and support tooling can isolate one org's objects
- **Unique keys**: No collisions between requests
- **Consistent pattern**: Same structure across all providers

The consumer does not need body keys. The web UI already has `requestId` on the trace and can fetch the combined payload directly through the API worker.

## Why R2 Specifically

### Same Platform, No Latency Penalty

R2 runs in Cloudflare's network alongside Workers. Storing to R2 from the proxy incurs minimal network latency (typically <10ms). External storage (S3, GCS) would add cross-provider round trips.

### S3-Compatible API

R2 uses the S3 API, making it familiar and well-tooled. If migration becomes necessary, switching to S3 requires only endpoint changes.

### No Egress Fees

R2 has no egress fees. The web UI fetches bodies repeatedly during debugging sessions without cost concerns. This enables liberal caching and refetching strategies.

### Integrated Bindings

Workers access R2 through type-safe bindings:

```typescript
interface Env {
  STORAGE: R2Bucket;
}

// Direct access, no SDK initialization
await c.env.STORAGE.put(key, body);
const object = await c.env.STORAGE.get(key);
```

No credentials management or SDK configuration required.

## Retention and Lifecycle

### 30-Day Retention

Bodies are retained for 30 days, then deleted via R2 lifecycle rules:

```json
{
  "rules": [
    {
      "id": "delete-old-bodies",
      "status": "Enabled",
      "expiration": { "days": 30 }
    }
  ]
}
```

30 days balances:

- **Debugging needs**: Covers the full Pro access window
- **Cost management**: Storage accumulates at ~10KB per request
- **Compliance**: Avoid indefinite storage of potentially sensitive data

Lifecycle is an age-bound, not the full cost control. Body Objects also count against the org's shared R2 Storage Budget; see [R2 Storage Caps](./0013-r2-storage-caps.md).

Read-time visibility still depends on the caller's current tier:

- **Hobby**: last 7 days
- **Pro**: last 30 days

### Cost Considerations

R2 pricing (as of 2024):

- Storage: $0.015/GB/month
- Operations: $0.36 per million Class A (writes)
- Operations: $0.036 per million Class B (reads)

For 1 million requests/month with average 20KB body size:

- Storage: 20GB \* $0.015 = $0.30/month
- Writes: 1M \* $0.36/M = $0.36/month
- Reads: Varies with UI usage

Cost is minimal compared to LLM API costs for the same traffic, but it is still bounded by the org's Storage Budget so abnormal traffic or abuse cannot grow R2 cost indefinitely.

## Handling Storage Failures

R2 writes can fail (network issues, rate limits). The proxy handles this gracefully:

```typescript
let reserved = false;

try {
  const reservation = await storageBudget.reserveStorage({
    orgId,
    objectClass: 'proxy_body',
    objectKey: bodyKey,
    bytes: payloadBytes,
    expiresAt,
  });

  if (!reservation.allowed) {
    return { bodyKey, stored: false, reason: 'storage_cap_exceeded' };
  }

  reserved = true;
  await storage.put(bodyKey, payload, putOptions);
  await storageBudget.commitStorage({ orgId, objectKey: bodyKey });
  return { bodyKey, stored: true };
} catch (error) {
  if (reserved) {
    await storageBudget.releaseStorage({ orgId, objectKey: bodyKey });
  }
  console.error('R2 storage failed:', error);
  return { bodyKey, stored: false };
}
```

When storage fails or the org is over its Storage Budget:

1. The queue message is still sent without stored body data
2. Trace metadata is still captured in Tinybird
3. The web UI shows "Body not available" for affected requests
4. Users can still see timing, tokens, and error information

This degraded mode preserves observability even when storage fails or storage is deliberately blocked to protect Trace Flow from runaway cost.

## Size Limits and Truncation

Large responses are truncated before storage:

```typescript
const MAX_RESPONSE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_CHUNKS = 5000;

if (totalSize + chunk.length > MAX_RESPONSE_SIZE) {
  truncated = true;
  // Stop capturing, continue streaming to client
}
```

Truncation limits:

- **20MB response size**: Handles most LLM responses with margin
- **5000 chunks**: Prevents chunk count explosion on long streams

When truncated:

- The full response streams to the client (no user impact)
- R2 stores only the captured portion
- The trace is flagged with `truncated: true`
- The web UI indicates incomplete body data

## Trade-offs

### Separate Fetch Required

Bodies aren't embedded in trace queries. The web UI makes additional requests to fetch bodies when expanding trace details. This adds:

- One API call per trace detail view
- Authentication overhead per request
- Potential latency for large bodies

We accept this because bodies are needed only for detailed inspection, not list views or aggregations.

### Eventual Consistency

R2 operations are eventually consistent. A body might not be immediately readable after write. In practice, the delay is imperceptible (milliseconds), and the queue processing delay exceeds R2 consistency delay.

### No Full-Text Search

Bodies in R2 aren't queryable. You can't search for "requests containing 'error'" without fetching all bodies. Full-text search would require:

- Indexing service (Elasticsearch, Meilisearch)
- Additional storage costs
- Synchronization complexity

We accepted this limitation. Search by trace metadata (model, error code, latency) covers most use cases.

### Bodies Outlive Traces

R2 lifecycle is separate from Tinybird retention. If Tinybird data is deleted before R2 lifecycle runs, orphaned bodies exist briefly. This is benign (no cost impact) and self-corrects via lifecycle rules.

### Budget Ledger Lag

The Storage Budget ledger decrements by declared expiration and scheduled reconciliation, not by an R2 lifecycle callback. It may temporarily over-count storage if reconciliation lags. We accept that because over-counting blocks optional body storage, while under-counting could allow runaway R2 cost.

## Outcome

R2 storage solves the body size problem while maintaining:

- **Queue efficiency**: Sub-1KB messages regardless of body size
- **Analytics performance**: Tinybird contains only trace metadata
- **Cost control**: Predictable storage costs with lifecycle management and org-level storage caps
- **Graceful degradation**: Storage failures don't block observability

The separation of concerns (trace metadata in Tinybird, bodies in R2) matches how users interact with the data: aggregate analytics on metadata, detailed inspection on demand.
