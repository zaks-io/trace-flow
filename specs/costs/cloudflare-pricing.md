# Cloudflare Platform Pricing Reference

Last updated: 2026-03-06. All prices USD.

## Workers Paid Plan - $5/month Base

Includes allowances across all Cloudflare developer services below.

### Workers (Compute)

| Metric                 | Free Tier       | Paid Included | Overage    |
| ---------------------- | --------------- | ------------- | ---------- |
| Requests               | 100K/day        | 10M/month     | $0.30/M    |
| CPU time               | 10ms/invocation | 30M ms/month  | $0.02/M ms |
| Max CPU per invocation | 10ms            | 30s (default) | -          |
| Data egress            | Free            | Free          | Free       |
| Static asset requests  | Free            | Free          | Free       |

### R2 (Object Storage)

| Metric                        | Free Tier   | Overage         |
| ----------------------------- | ----------- | --------------- |
| Storage (Standard)            | 10 GB-month | $0.015/GB-month |
| Storage (Infrequent Access)   | -           | $0.01/GB-month  |
| Class A ops (PUT, POST, LIST) | 1M/month    | $4.50/M         |
| Class B ops (GET, HEAD)       | 10M/month   | $0.36/M         |
| Class A ops (IA)              | -           | $9.00/M         |
| Class B ops (IA)              | -           | $0.90/M         |
| IA retrieval fee              | -           | $0.01/GB        |
| Delete ops                    | Free        | Free            |
| Data egress                   | Free        | Free            |

### KV (Key-Value Store)

| Metric   | Free Tier | Paid Included | Overage        |
| -------- | --------- | ------------- | -------------- |
| Reads    | 100K/day  | 10M/month     | $0.50/M        |
| Writes   | 1K/day    | 1M/month      | $5.00/M        |
| Deletes  | 1K/day    | 1M/month      | $5.00/M        |
| List ops | 1K/day    | 1M/month      | $5.00/M        |
| Storage  | 1 GB      | 1 GB          | $0.50/GB-month |

### Queues

| Metric            | Free Tier | Paid Included     | Overage |
| ----------------- | --------- | ----------------- | ------- |
| Operations        | 10K/day   | 1M/month          | $0.40/M |
| Message retention | 24 hours  | 4 days (up to 14) | -       |

1 operation = each 64KB of message data (written, read, or deleted). A 127KB message = 2 operations.

### Durable Objects

| Metric             | Paid Included   | Overage       |
| ------------------ | --------------- | ------------- |
| Requests           | 1M/month        | $0.15/M       |
| Duration (compute) | 400K GB-s/month | $12.50/M GB-s |

**SQLite Storage (used by trace-flow):**

| Metric      | Paid Included | Overage        |
| ----------- | ------------- | -------------- |
| Row reads   | 25B/month     | $0.001/M rows  |
| Row writes  | 50M/month     | $1.00/M rows   |
| Data stored | 5 GB-month    | $0.20/GB-month |

**KV Storage (legacy, not used):**

| Metric      | Paid Included | Overage        |
| ----------- | ------------- | -------------- |
| Read units  | 1M/month      | $0.20/M        |
| Write units | 1M/month      | $1.00/M        |
| Storage     | 1 GB          | $0.20/GB-month |

### Workers Static Assets

- Requests: Free and unlimited
- Storage: Free
- Only SSR Worker invocations incur standard Workers charges

## Trace Flow Cost Drivers

The current runtime uses Cloudflare in two ingestion paths.

### LLM Request Path

- Proxy Worker request and CPU for each proxied provider call
- R2 Class A write for each stored `bodies/{requestId}` object
- Queue operations for `trace-flow-requests-*`
- Proxy Consumer CPU and `TRACE_BATCHER` Durable Object requests/storage
- API Worker reads and R2 Class B reads when users open stored bodies
- KV reads for API key, subscription, and pricing lookups, mostly hidden by Worker-side caches

### Agent Conversation Path

- Agent Ingest Worker request and CPU per collector upload
- `COLLECTOR_CREDS` KV reads for Collector Credential auth
- `agent-ingest-*` queue operations, charged per 64 KiB chunk
- Agent Consumer CPU for validation, pricing, row mapping, and Tinybird inserts
- `AGENT_FACT_BATCHER` Durable Object requests/storage for fact dedupe before Tinybird writes
- `MODEL_PRICING` KV reads for server-side cost calculation

Raw transcript R2 storage is deferred. Do not model agent raw transcript R2 storage until that path
has an R2 binding, lifecycle policy, and launch decision.

## Sources

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
