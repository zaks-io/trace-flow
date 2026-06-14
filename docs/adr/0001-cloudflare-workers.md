# Cloudflare Workers: Edge-First Serverless Platform

## Decision

Trace Flow runs on Cloudflare Workers as its primary compute platform. Runtime workers include proxy, proxy consumer, agent ingest, agent consumer, API, and web, with environment-specific bindings deployed to the edge.

## Context

An LLM observability proxy has strict latency requirements. Every millisecond added to the request path directly impacts user experience. The proxy sits between clients and LLM providers, meaning any overhead compounds across potentially thousands of requests per minute.

Beyond latency, we needed:

- Native streaming support for SSE responses
- Integrated storage (R2) and messaging (Queues)
- Global deployment without infrastructure management
- Predictable pricing at scale

## Alternatives Considered

### AWS Lambda

Lambda was the obvious first choice given its market dominance. However, several issues made it unsuitable:

**Cold starts matter for proxies.** Lambda cold starts range from 100ms to several seconds depending on runtime and package size. For a proxy that needs sub-10ms overhead, this is unacceptable. While provisioned concurrency exists, it adds significant cost and operational complexity.

**Streaming is second-class.** Lambda added response streaming in 2023, but it remains awkward. The programming model requires special handlers and has limitations around payload sizes. SSE streams from LLM providers need native stream handling, not bolted-on support.

**Regional deployment requires configuration.** Lambda runs in specific regions. Running a globally distributed proxy means deploying to multiple regions and managing routing. CloudFront helps but adds another layer.

**Integrated services require glue.** Connecting Lambda to SQS, S3, and API Gateway requires explicit configuration for each. The Worker model of bindings is significantly simpler.

### Vercel Functions

Vercel excels at frontend deployment but falls short for backend proxies:

**Focused on Next.js.** The platform optimizes for React Server Components and the Next.js model. A pure proxy worker is fighting the framework rather than leveraging it.

**Limited streaming control.** Vercel's edge functions support streaming but with less control than Workers. The TransformStream pattern we use for simultaneous streaming and capture is harder to implement.

**No integrated queue.** There's no equivalent to Cloudflare Queues. We'd need to integrate external queuing (SQS, Redis) with the associated latency and complexity.

**Pricing model.** Vercel's per-request pricing with bandwidth charges makes high-throughput proxying expensive compared to Workers' included egress.

### Traditional Servers (ECS, Kubernetes)

Container-based deployment was considered but rejected:

**Operational overhead.** Managing containers, autoscaling, health checks, and deployments requires significant DevOps investment. Workers abstract this entirely.

**Cold starts remain.** Even with container orchestration, scaling from zero or adding capacity takes seconds, not milliseconds.

**Global deployment is complex.** Running containers in multiple regions requires managing multiple clusters, databases, and synchronization.

**Cost at rest.** Containers incur charges whether serving traffic or not. Workers have no idle cost.

## Why Cloudflare Workers

### Zero Cold Starts

Workers use V8 isolates rather than containers. Isolates spin up in under 5ms with no cold start penalty. Every request, including the first after hours of idle, gets the same performance.

This is fundamental to proxy operation. Users never experience variable latency based on traffic patterns.

### Native Streaming

The Workers runtime provides first-class stream support:

```typescript
// Duplicate request body for proxying and capture
const [streamToProxy, streamToCapture] = request.body.tee();

// Capture response while streaming to client
const capture = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk);
    capturedChunks.push(chunk);
  },
});
```

This pattern enables simultaneous streaming to clients and data capture without buffering entire responses in memory.

### Integrated Platform Services

Workers provides native bindings to complementary services:

- **R2 Storage**: S3-compatible object storage for request/response bodies
- **Queues**: Reliable message delivery between workers
- **KV**: Low-latency key-value storage for API key validation
- **Durable Objects**: Stateful actors for trace batching

These bindings are type-safe and require no network configuration:

```typescript
// Direct binding access, no SDK initialization
await c.env.STORAGE.put(`requests/${requestId}`, body);
await c.env.REQUEST_QUEUE.send(message);
```

### Global Edge Deployment

Workers deploy to 300+ locations worldwide automatically. A request from Tokyo hits a Tokyo data center; a request from London hits a London data center. No region configuration or routing rules required.

For a proxy, this means requests to LLM providers originate from edge locations geographically close to either the client or the provider, minimizing network latency.

### waitUntil Pattern

The `waitUntil` API is crucial for proxy performance:

```typescript
// Return response immediately
const response = await fetch(targetUrl, { body: streamToProxy });

// Do observability work after response completes
c.executionCtx.waitUntil(async () => {
  await storeRequestResponse(storage, requestId, requestBody, responseBody);
  await queue.send(queueMessage);
});

return new Response(readable, response);
```

The client receives their response without waiting for storage or queue operations. The Worker continues running to complete observability tasks. This is essential for achieving minimal proxy overhead.

## Trade-offs

### CPU and Memory Limits

Workers have constrained resources:

- **CPU time**: 30 seconds (standard) or 15 minutes (extended)
- **Memory**: 128MB per isolate
- **Request size**: 100MB maximum

For our use case, these limits are acceptable. LLM requests rarely exceed a few megabytes, and processing completes well under CPU limits. The response capture implements truncation at 20MB to stay safely within memory constraints.

### Different Programming Model

Workers use a specific programming model:

- No filesystem access (use R2 or KV)
- Limited Node.js API compatibility (requires compatibility flags)
- Stateless execution (use Durable Objects for state)

This required adapting some patterns. The `nodejs_compat` flag provides most Node.js APIs we need. State management uses Durable Objects for the trace batcher rather than in-memory caching.

### Vendor Lock-in

Deep integration with R2, Queues, and Durable Objects creates platform coupling. Migrating to another platform would require rewriting storage, messaging, and state management.

We accepted this trade-off because:

1. The integrated services significantly reduce complexity
2. Cloudflare's pricing and reliability track record are strong
3. Migration would be a rewrite regardless due to different runtime semantics

## Outcome

The Workers platform delivers:

- **<5ms proxy overhead** on typical requests
- **Zero cold starts** regardless of traffic patterns
- **Global deployment** without infrastructure management
- **Integrated services** with type-safe bindings

The trade-offs are acceptable for our use case, and the platform enables a simpler architecture than alternatives would allow.
