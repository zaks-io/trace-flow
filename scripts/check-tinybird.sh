#!/bin/bash

# Check recent traces in Tinybird
# Usage: ./scripts/check-tinybird.sh

echo "=== Recent llm.request traces ==="
tb --cloud sql "SELECT TraceId, SpanName, toDateTime(Timestamp / 1000000000) as TimestampUTC FROM otel_traces WHERE SpanName = 'llm.request' ORDER BY Timestamp DESC LIMIT 15"

echo ""
echo "=== Total trace count ==="
tb --cloud sql "SELECT count() as total FROM otel_traces"

echo ""
echo "=== Quarantine table schema ==="
tb --cloud sql "DESCRIBE otel_traces_quarantine"

echo ""
echo "=== Check quarantine table for rejected rows ==="
tb --cloud sql "SELECT * FROM otel_traces_quarantine LIMIT 5"
