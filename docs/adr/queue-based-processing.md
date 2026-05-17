# Queue-Based Processing: Decoupling Proxy from Observability

## Decision

The proxy worker sends metadata to a Cloudflare Queue immediately after capturing request/response data. A separate consumer worker processes queue messages asynchronously, transforming them into OpenTelemetry traces and inserting them into Tinybird.

## Context

An observability proxy has two competing priorities:

1. **Minimize latency**: Users care about response time, not observability
2. **Capture everything**: The platform needs complete, reliable data

These priorities conflict. Sending traces to an analytics backend adds latency. Database insertions can fail. Retries block responses.

The queue decouples these concerns: the proxy focuses on low-latency streaming, and the consumer handles reliable data processing.

## Why Not Process Traces Synchronously

The naive approach processes traces inline:

```typescript
// DON'T DO THIS
const response = await fetch(targetUrl, { body: requestBody });
await insertTraceIntoTinybird(trace); // Blocks response!
return response;
```

This adds Tinybird round-trip latency (50-200ms) to every request. During Tinybird outages, requests fail even though the LLM provider responded successfully.

The `waitUntil` pattern improves this:

```typescript
const response = await fetch(targetUrl, { body: requestBody });
c.executionCtx.waitUntil(insertTraceIntoTinybird(trace));
return response; // Returns immediately
```

This returns the response without waiting, but problems remain:

1. **No retry on failure**: If Tinybird insertion fails, the trace is lost
2. **CPU time limits**: Complex processing consumes the Worker's 30-second CPU budget
3. **Backpressure**: Traffic spikes overwhelm Tinybird without rate limiting
4. **Memory pressure**: Holding traces in memory during high-throughput periods risks OOM

## How Queue-Based Processing Works

### Proxy Worker (Producer)

The proxy captures request/response data and enqueues metadata:

```typescript
// Store bodies in R2 (fast, local to edge)
await storeBodies(storage, requestId, requestBody, responseBody, truncated, logger, orgId);

// Enqueue lightweight metadata (no bodies in queue)
const queueMessage = {
  requestId,
  traceId,
  apiKey,
  targetUrl,
  responseStatus,
  timing: { requestStart, responseComplete },
  tokens,
};

await c.env.REQUEST_QUEUE.send(queueMessage);
```

The queue message is small (under 1KB typically). Bodies are stored in R2 separately under `bodies/{requestId}` and fetched later by the API worker. This keeps queue operations fast and within Cloudflare Queues' 128KB message limit.

### Consumer Worker (Processor)

The consumer receives batches of messages and processes them:

```typescript
export default {
  async queue(batch: MessageBatch<QueueMessageUnion>, env: Env) {
    for (const message of batch.messages) {
      try {
        const traces = buildTraces(message.body);
        await batcher.addTraces(traces);
        message.ack();
      } catch (error) {
        message.retry();
      }
    }
  },
};
```

Messages are acknowledged only after successful processing. Failures trigger automatic retries with exponential backoff.

## Queue Configuration

The consumer's queue configuration in `wrangler.toml`:

```toml
[[queues.consumers]]
queue = "trace-flow-requests-prod"
max_batch_size = 100
max_batch_timeout = 5
max_concurrency = 20
max_retries = 5
dead_letter_queue = "trace-flow-requests-dlq-prod"
```

### Batch Size (100)

Batching amortizes overhead across multiple traces. A batch of 100 messages makes one Tinybird insertion rather than 100 individual calls. This reduces:

- Network round trips
- Tinybird API call volume
- Processing time per trace

The batch size of 100 balances throughput with memory usage. Larger batches increase memory pressure on the Worker.

### Batch Timeout (5 seconds)

Low-traffic periods may not fill a batch of 100. The 5-second timeout ensures traces are processed promptly even during quiet periods. At minimum, traces are processed within 5 seconds of capture.

### Concurrency (20)

Multiple consumer instances can process batches in parallel. With `max_concurrency = 20`, up to 20 Workers process batches simultaneously during high traffic. This provides horizontal scaling without configuration.

### Retry Strategy (5 retries)

Failed messages are retried with exponential backoff:

- Retry 1: ~1 second delay
- Retry 2: ~2 second delay
- Retry 3: ~4 second delay
- Retry 4: ~8 second delay
- Retry 5: ~16 second delay

After 5 failures, messages move to the dead letter queue for investigation.

### Dead Letter Queue

Messages that exhaust retries go to `trace-flow-requests-dlq-*`. This preserves failed traces for:

- Debugging processing errors
- Manual reprocessing after fixes
- Monitoring failure patterns

We monitor DLQ depth as an operational metric.

## Trace Batching with Durable Objects

The consumer doesn't send traces to Tinybird immediately. It uses a Durable Object (TraceBatcher) for additional batching:

```typescript
// Consumer adds traces to batcher
const batcher = env.TRACE_BATCHER.get(batcherId);
await batcher.addTraces(traces);

// Batcher accumulates and flushes periodically
class TraceBatcher {
  async addTraces(traces: TinybirdTrace[]) {
    this.storage.sql.exec('INSERT INTO traces ...');

    if (this.traceCount >= BATCH_SIZE) {
      await this.flush();
    } else {
      await this.scheduleFlush();
    }
  }
}
```

The batcher provides:

1. **Larger batches**: Accumulates up to 10,000 traces before flushing
2. **Durability**: SQLite storage survives Worker restarts
3. **Time-based flushing**: Flushes every 5 seconds minimum
4. **Sharding**: Multiple batchers distribute load

### Why Two Levels of Batching

Queue batching (100 messages) handles worker-level parallelism. Durable Object batching (10,000 traces) optimizes Tinybird insertion:

- Tinybird performs best with large batch inserts
- Reducing API calls reduces rate limit pressure
- Single network call for thousands of traces

## Benefits

### User Latency Unaffected

The proxy returns responses immediately after streaming completes. Queue and Tinybird operations happen asynchronously. Users experience only the LLM provider latency plus minimal proxy overhead.

### Traffic Spikes Absorbed

Cloudflare Queues buffer messages during traffic spikes. The consumer processes at a sustainable rate regardless of incoming volume. No traces are lost during burst traffic.

### Reliable Delivery

The retry mechanism handles transient failures:

- Tinybird timeouts
- Network issues
- Consumer errors

Only persistent failures (bad data, schema mismatches) reach the dead letter queue.

### Independent Scaling

Proxy and consumer scale independently. Heavy proxy load doesn't impact consumer performance. Consumer batching optimizes for Tinybird efficiency regardless of arrival rate.

## Trade-offs

### Eventual Consistency

Traces appear in Tinybird after a delay:

- Queue delivery: typically <100ms
- Batch accumulation: up to 5 seconds
- Tinybird insertion: 1-2 seconds

Total latency from request completion to trace visibility is typically 2-10 seconds. For real-time debugging, this delay can be frustrating. The web UI shows "processing" states for recently-captured traces.

### Additional Complexity

The queue adds moving parts:

- Queue configuration and monitoring
- Consumer worker deployment
- Dead letter queue handling
- Durable Object state management

This complexity is justified by the reliability and performance benefits.

### Message Size Limits

Cloudflare Queues limits messages to 128KB. Large request/response bodies don't fit in queue messages. This drove the R2 storage decision: bodies go to R2, queue messages contain only references.

### Ordering Not Guaranteed

Messages may be processed out of order, especially during retries. This doesn't affect trace correctness (each trace is independent) but can cause traces to appear in Tinybird out of chronological order. Tinybird queries sort by timestamp to restore order.

## Outcome

Queue-based processing achieves both goals:

- **Minimal proxy latency**: Queue send is <5ms, non-blocking
- **Reliable data capture**: Retries and DLQ ensure no data loss

The eventual consistency trade-off is acceptable for observability data. Users view traces seconds to minutes after capture, not milliseconds. The queue provides the buffer needed to achieve both reliability and performance.
