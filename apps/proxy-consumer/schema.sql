-- ClickHouse schema for OpenTelemetry traces
-- Run this in your ClickHouse Cloud console to create the table

CREATE TABLE IF NOT EXISTS otel_trace_spans (
    `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TraceId` String CODEC(ZSTD(1)),
    `SpanId` String CODEC(ZSTD(1)),
    `ParentSpanId` String CODEC(ZSTD(1)),
    `TraceState` String CODEC(ZSTD(1)),
    `SpanName` LowCardinality(String) CODEC(ZSTD(1)),
    `SpanKind` LowCardinality(String) CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SpanAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `Duration` Int64 CODEC(ZSTD(1)),
    `StatusCode` LowCardinality(String) CODEC(ZSTD(1)),
    `StatusMessage` String CODEC(ZSTD(1)),
    `Events.Timestamp` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Events.Name` Array(LowCardinality(String)) CODEC(ZSTD(1)),
    `Events.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Links.TraceId` Array(String) CODEC(ZSTD(1)),
    `Links.SpanId` Array(String) CODEC(ZSTD(1)),
    `Links.TraceState` Array(String) CODEC(ZSTD(1)),
    `Links.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1))
)
ENGINE = MergeTree()
ORDER BY (ServiceName, SpanName, Timestamp)
PARTITION BY toDate(Timestamp)
TTL Timestamp + INTERVAL 30 DAY;

-- Optional: Create materialized columns for frequently queried attributes
-- Uncomment and adjust based on your needs:

-- ALTER TABLE otel_trace_spans ADD COLUMN `ai_provider` String MATERIALIZED SpanAttributes['gen_ai.system'];
-- ALTER TABLE otel_trace_spans ADD COLUMN `ai_model` String MATERIALIZED SpanAttributes['gen_ai.request.model'];
-- ALTER TABLE otel_trace_spans ADD COLUMN `ai_request_id` String MATERIALIZED SpanAttributes['gen_ai.request_id'];
-- ALTER TABLE otel_trace_spans ADD COLUMN `http_status_code` Int32 MATERIALIZED CAST(SpanAttributes['http.status_code'], 'Int32');

-- Create indexes for common query patterns
-- ALTER TABLE otel_trace_spans ADD INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1;
-- ALTER TABLE otel_trace_spans ADD INDEX idx_span_id SpanId TYPE bloom_filter(0.01) GRANULARITY 1;
