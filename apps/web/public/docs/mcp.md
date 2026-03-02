# MCP Server

Connect your AI assistant directly to Trace Flow data with MCP.

Endpoint: `https://mcp.trace-flow.dev/mcp`

## What it gives you

- Query recent traces from inside your editor
- Drill into full trace details (spans, tokens, costs, status)
- Speed up debugging and production investigation workflows

## Configuration

```json
{
  "mcpServers": {
    "trace-flow": {
      "type": "http",
      "url": "https://mcp.trace-flow.dev/mcp"
    }
  }
}
```

## Available tools

## `list_traces`

Query recent traces with optional filtering.

Parameters:

- `provider` (string): filter by provider
- `model` (string): filter by model
- `status` (enum): `STATUS_CODE_OK` or `STATUS_CODE_ERROR`
- `hours` (number): lookback window (default 24, max 168)
- `limit` (number): result limit (default 10, max 25)
- `cursor` (string): pagination cursor

## `get_trace`

Fetch a specific trace by ID.

Parameters:

- `trace_id` (required string): 32-char trace ID

## Example prompts for your agent

- "Use `list_traces` with status `STATUS_CODE_ERROR` and `hours=1` to find failed requests."
- "Use `get_trace` for this trace and summarize tokens, cost, and likely root cause."
- "Find traces with high latency in the last 24 hours and compare providers."

## Auth behavior

First-time use triggers OAuth authorization with your Trace Flow account. After consent, tokens refresh automatically.
