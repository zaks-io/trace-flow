# Tinybird for Analytics Storage

Trace Flow stores all LLM observability data in Tinybird, a managed ClickHouse service optimized for real-time analytics. This document explains why we chose Tinybird over alternatives and the trade-offs involved.

## The Problem

We needed a database that could:

1. Ingest millions of trace events per day with sub-second latency
2. Support fast aggregation queries across time ranges (dashboards, summaries)
3. Handle high-cardinality data (trace IDs, span IDs, model names)
4. Provide TTL-based data expiration for cost control
5. Integrate with our Cloudflare Workers architecture

## Alternatives Considered

### PostgreSQL

PostgreSQL was the default choice given our familiarity and the Convex backend already using it for user data. However:

- **Aggregation performance**: Time-series aggregations (avg latency, token sums, error rates) become slow at scale. Even with proper indexing, scanning millions of rows for dashboard queries takes seconds.
- **Storage efficiency**: Row-oriented storage means each trace stores all columns, even when queries only need a few. ClickHouse's columnar format compresses trace data by 10-20x.
- **Partitioning complexity**: Implementing time-based partitioning and TTL requires manual partition management. ClickHouse handles this declaratively.

We use PostgreSQL (via Convex) for user accounts, API keys, and configuration where ACID transactions matter. Trace data has different requirements.

### Elasticsearch

Elasticsearch excels at full-text search but is overkill for structured trace data:

- **Cost**: Elasticsearch clusters are expensive to run. Our traces are structured JSON, not documents requiring full-text indexing.
- **Query complexity**: Aggregation queries in Elasticsearch DSL are verbose compared to SQL.
- **Operational overhead**: Managing Elasticsearch clusters requires dedicated expertise.

If we needed full-text search across request/response bodies, Elasticsearch would be worth considering. We store bodies in R2 instead and search by trace ID.

### BigQuery / Snowflake

Cloud data warehouses offer massive scale but wrong latency characteristics:

- **Query latency**: BigQuery queries have 1-3 second cold start times. Dashboard widgets need sub-200ms response.
- **Cost model**: Pay-per-query pricing penalizes interactive dashboards that refresh frequently.
- **Real-time ingestion**: Both are batch-oriented. Trace data arrives continuously and users expect immediate visibility.

These would be better suited for batch analytics or data science workloads, not operational dashboards.

## Why Column-Oriented for Trace Data

LLM trace data has characteristics that favor columnar storage:

**Read patterns are aggregation-heavy**. Dashboard queries compute averages, sums, and percentiles across specific columns:

```sql
SELECT
    avg(Duration) / 1000000 as avg_duration_ms,
    sum(JSONExtractInt(SpanAttributes, 'gen_ai.usage.input_tokens')) as total_input_tokens,
    countIf(StatusCode = 'STATUS_CODE_ERROR') as error_count
FROM otel_traces
WHERE ReceivedAt >= now() - INTERVAL 1 DAY
```

Column-oriented storage reads only the columns needed, not entire rows.

**High compression ratios**. Many columns have low cardinality (StatusCode has 3 values, ServiceName is constant, SpanKind has 5 values). ClickHouse compresses these to bytes per row instead of storing full strings.

**Time-series access patterns**. Queries almost always filter by time range first. ClickHouse's MergeTree engine with time-based partitioning reads only relevant data blocks.

## Why Managed Tinybird Over Self-Hosted ClickHouse

Running ClickHouse ourselves was considered but rejected for several reasons:

**Operational simplicity**. Tinybird handles replication, backups, upgrades, and scaling. Our team focuses on product, not database operations.

**Edge integration**. Tinybird's Events API accepts NDJSON over HTTP, matching our Cloudflare Workers architecture. No need for ClickHouse-native protocols or connection pooling.

**Built-in API layer**. Tinybird pipes generate REST endpoints from SQL queries. We define a pipe like `traces_summary.pipe` and get a `/v0/pipes/traces_summary.json` endpoint automatically.

**JWT authentication**. Tinybird supports short-lived JWTs with scoped permissions. Critical for our frontend-direct query pattern (see jwt-tinybird-auth.md).

## Schema Design

Our primary datasource follows OpenTelemetry trace conventions:

```
ENGINE "MergeTree"
ENGINE_SORTING_KEY "ReceivedAt, ApiKey, TraceId, SpanId"
ENGINE_PARTITION_KEY "toYYYYMMDD(toDateTime(ReceivedAt / 1000000000))"
ENGINE_TTL "toDateTime(ReceivedAt / 1000000000) + INTERVAL 90 DAY"
```

**Sorting key order matters**. `ReceivedAt` first because most queries filter by time. `ApiKey` second for multi-tenant isolation. `TraceId` and `SpanId` for point lookups.

**Daily partitions**. Balance between partition count (hundreds, not thousands) and data pruning efficiency.

**90-day TTL**. Automatic deletion of old data. Keeps storage costs predictable.

**SpanAttributes as JSON string**. We store OpenTelemetry attributes as a JSON blob and extract fields at query time using `JSONExtractString`. This provides schema flexibility as we add new GenAI semantic convention attributes.

## Benefits We Have Seen

**Query performance**. Dashboard summary queries execute in 50-200ms even with millions of traces. The column-oriented format and sorting key make aggregations fast.

**Compression**. Trace data compresses to ~15% of original size. LowCardinality columns (StatusCode, ServiceName, SpanKind) achieve 50-100x compression.

**Development velocity**. Pipe-based API endpoints let us iterate on queries without deploying code. Change the SQL, Tinybird regenerates the API.

**Cost predictability**. Fixed monthly pricing based on data volume, not query count. Interactive dashboards do not spike costs.

## Trade-offs and Limitations

**Vendor lock-in**. Tinybird-specific features (pipes, JWTs, materialized views syntax) do not transfer to other platforms. Migrating would require rewriting the query layer.

**Cost at scale**. Tinybird's pricing works well for millions of traces but becomes expensive at billions. At that scale, self-hosted ClickHouse might be cheaper despite operational overhead.

**No transactions**. ClickHouse is eventually consistent and lacks ACID transactions. We cannot update or delete individual traces atomically. TTL handles expiration; corrections require new insert.

**Learning curve**. ClickHouse SQL has quirks (no UPDATE/DELETE, different NULL handling, specialized functions). Team members familiar with PostgreSQL needed adjustment time.

## Conclusion

Tinybird provides the right balance of performance, simplicity, and cost for our observability use case. The column-oriented architecture handles aggregation-heavy dashboard queries efficiently, and the managed service lets us focus on product development. The trade-off of vendor lock-in is acceptable given the operational simplicity and the clear migration path to self-hosted ClickHouse if economics change at scale.
