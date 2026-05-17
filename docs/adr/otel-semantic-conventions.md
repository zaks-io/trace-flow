# OpenTelemetry GenAI Semantic Conventions

Trace Flow structures all LLM trace data according to OpenTelemetry semantic conventions, specifically the GenAI conventions for AI/ML workloads. This document explains why we adopted this standard and how we implement it.

## The Problem

Every LLM provider returns data in a different format:

- OpenAI uses `usage.prompt_tokens` and `usage.completion_tokens`
- Anthropic uses `usage.input_tokens` and `usage.output_tokens`
- Google uses `usageMetadata.promptTokenCount` and `usageMetadata.candidatesTokenCount`

Without standardization, our dashboard would need provider-specific logic everywhere. Queries, visualizations, and alerts would all handle each provider differently.

## Why OpenTelemetry Standards

OpenTelemetry provides a vendor-neutral observability framework with semantic conventions that define standard attribute names and structures. We chose to follow OTel conventions for several reasons:

**Interoperability**. Users with existing OpenTelemetry setups can send traces to Trace Flow using standard OTel exporters. Our OTLP ingestion endpoint accepts any compliant trace.

**Tooling compatibility**. OTel-formatted traces work with Jaeger, Grafana, Honeycomb, and other observability tools. Users can export their Trace Flow data to other systems.

**Standard vocabulary**. When a developer sees `gen_ai.usage.input_tokens`, they know what it means. No need to learn Trace Flow-specific naming.

**Future-proofing**. As the OTel community adds new GenAI conventions (thinking tokens, tool calls, structured outputs), we adopt them without inventing our own.

## GenAI Semantic Convention Specifics

The OTel GenAI semantic conventions define attributes under the `gen_ai.*` namespace. Here is how we use them:

### Core Attributes

| Attribute               | Description       | Example                           |
| ----------------------- | ----------------- | --------------------------------- |
| `gen_ai.system`         | LLM provider      | `openai`, `anthropic`, `google`   |
| `gen_ai.request.model`  | Requested model   | `gpt-4`, `claude-3-opus`          |
| `gen_ai.response.model` | Actual model used | `gpt-4-0613`                      |
| `gen_ai.operation.name` | Operation type    | `chat`, `completion`, `embedding` |

### Token Usage

| Attribute                                  | Description                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `gen_ai.usage.input_tokens`                | Total prompt-side tokens (`uncached + cache read + cache write`) |
| `gen_ai.usage.input_tokens_uncached`       | Prompt tokens billed at the base input rate                      |
| `gen_ai.usage.output_tokens`               | Tokens in response                                               |
| `gen_ai.usage.reasoning_tokens`            | Tokens used for chain-of-thought (o1, Claude thinking)           |
| `gen_ai.usage.cache_read_input_tokens`     | Prompt tokens served from cache                                  |
| `gen_ai.usage.cache_creation_input_tokens` | Prompt tokens written to cache                                   |

### Response Metadata

| Attribute                           | Description                                           |
| ----------------------------------- | ----------------------------------------------------- |
| `gen_ai.finish_reason`              | Why generation stopped (`stop`, `length`, `tool_use`) |
| `gen_ai.response_id`                | Provider's response identifier                        |
| `gen_ai.server.time_to_first_token` | TTFT in milliseconds                                  |
| `gen_ai.tokens_per_second`          | Output token throughput                               |

### Cost Tracking (Extension)

OTel does not yet define cost attributes, so we use a consistent extension pattern:

| Attribute                     | Description                                          |
| ----------------------------- | ---------------------------------------------------- |
| `gen_ai.cost.input`           | Uncached input token cost in microdollars            |
| `gen_ai.cost.output`          | Output token cost in microdollars                    |
| `gen_ai.cost.total`           | Total cost in microdollars                           |
| `gen_ai.cost.cache_read`      | Cache read token cost in microdollars                |
| `gen_ai.cost.cache_creation`  | Cache write token cost in microdollars               |
| `gen_ai.cost.prompt_baseline` | Prompt-side cost at the base input rate (no caching) |
| `gen_ai.cost.cache_impact`    | Prompt-side savings or penalty versus the baseline   |
| `gen_ai.cost.upstream`        | Provider-reported upstream cost when available       |
| `gen_ai.cost.reasoning`       | Reasoning token cost                                 |

## Mapping Provider Responses

The consumer worker transforms each provider's response format to OTel conventions. Here is the mapping logic:

### OpenAI

```typescript
// OpenAI response
{ usage: { prompt_tokens: 100, completion_tokens: 50 } }

// Mapped to OTel
{
  'gen_ai.usage.input_tokens': '100',
  'gen_ai.usage.output_tokens': '50'
}
```

### Anthropic

```typescript
// Anthropic response
{ usage: { input_tokens: 100, output_tokens: 50 } }

// Mapped to OTel (direct mapping, same names)
{
  'gen_ai.usage.input_tokens': '100',
  'gen_ai.usage.output_tokens': '50'
}
```

### Google

```typescript
// Google response
{ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }

// Mapped to OTel
{
  'gen_ai.usage.input_tokens': '100',
  'gen_ai.usage.output_tokens': '50'
}
```

This normalization happens once in the consumer worker. All downstream code works with a single format.

## Span Naming Convention

OTel GenAI conventions specify span naming as `{gen_ai.operation.name} {gen_ai.request.model}`:

```typescript
const spanName = model ? `${operationName} ${model}` : operationName;
// Examples: "chat gpt-4", "completion claude-3-opus", "embedding text-embedding-3-small"
```

This naming pattern makes traces immediately recognizable in visualization tools.

## Trace Structure

We create a span hierarchy that represents the LLM request lifecycle:

```
chat gpt-4 (root span, SPAN_KIND_CLIENT)
├── gen_ai.response.text (child span, content block)
├── gen_ai.response.tool_use (child span, tool call)
└── gen_ai.response.thinking (child span, reasoning)
```

Each span carries its own attributes. The root span has request-level metadata (tokens, cost, latency). Child spans have content-specific metadata (tool names, content types).

## Events for Timeline Visualization

OTel events capture point-in-time occurrences within a span. We use them for:

**Input events**: What went into the request

- `input.system` - System prompt
- `input.text` - User message content
- `input.tool_result` - Tool execution result

**Output events**: What came back

- `output.text` - Generated text content
- `output.tool_use` - Tool call request
- `output.thinking` - Reasoning content
- `output.time_to_first_token` - TTFT measurement

Events appear on the trace timeline, showing the sequence of inputs and outputs.

## Materialized View for Performance

Extracting JSON attributes at query time is expensive. We create a materialized view that pre-extracts common GenAI attributes:

```sql
SELECT
    coalesce(nullIf(JSONExtractString(SpanAttributes, 'gen_ai.operation.name'), ''), '') AS OperationName,
    coalesce(nullIf(JSONExtractString(SpanAttributes, 'gen_ai.system'), ''), '') AS Provider,
    coalesce(nullIf(JSONExtractString(SpanAttributes, 'gen_ai.request.model'), ''), '') AS Model
FROM otel_traces
```

The `otel_traces_genai` datasource has indexed columns for `OperationName`, `Provider`, and `Model`, making filtered queries much faster.

## Benefits

**Unified queries**. Dashboard SQL queries work across all providers without conditional logic:

```sql
SELECT
    JSONExtractString(SpanAttributes, 'gen_ai.system') as provider,
    sum(JSONExtractInt(SpanAttributes, 'gen_ai.usage.input_tokens')) as total_input
FROM otel_traces
GROUP BY provider
```

**Standard tooling works**. Users can export traces to Jaeger or other OTel-compatible tools. The traces make sense without Trace Flow-specific documentation.

**Community alignment**. As the OTel GenAI working group adds new conventions (vision tokens, audio duration, structured output schemas), we adopt them with confidence that the naming is stable.

## Trade-offs

**Convention evolution**. GenAI semantic conventions are still experimental. Some attribute names may change, requiring migration.

**Attribute verbosity**. OTel attribute names are long (`gen_ai.usage.cache_read_input_tokens` vs `cached_tokens`). This increases storage slightly, though compression mitigates it.

**Extension risk**. Our cost attributes (`gen_ai.cost.*`) are not official OTel. If OTel adopts different naming, we will need to migrate.

## Conclusion

Following OpenTelemetry GenAI semantic conventions provides a stable, vendor-neutral foundation for LLM observability. The upfront work of mapping provider responses pays off in simpler queries, better interoperability, and alignment with the broader observability ecosystem.
