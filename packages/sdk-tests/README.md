# SDK Integration Tests

Test scripts for verifying AI SDK compatibility with the proxy gateway. Uses a unified CLI to run any provider and scenario from a single entrypoint.

## Quick Start

```bash
cd packages/sdk-tests
bun install
cp .env.example .env
# Edit .env with your API keys
```

Start the proxy (from repo root):

```bash
bun run dev:all
```

Run tests:

```bash
bun run test              # All configured providers, basic scenario
bun run test:openai       # Single provider
bun run test:all          # All providers
```

## CLI

The canonical entrypoint is `src/cli.ts`. Run with:

```bash
bun run src/cli.ts <command> [options]
```

### Commands

**`run`** — Execute test scenarios

```bash
bun run src/cli.ts run -p openai              # Single provider
bun run src/cli.ts run -p openai,anthropic    # Multiple providers
bun run src/cli.ts run -s basic                # Default: non-streaming + streaming
bun run src/cli.ts run -s tools -p groq       # Tool-calling scenario (Groq)
bun run src/cli.ts run -s shared-trace-multi-stream -p anthropic --requests 3
bun run src/cli.ts run --json                 # JSON output for CI
bun run src/cli.ts run -i                     # Interactive mode
```

**`providers`** — List providers and API key status

```bash
bun run src/cli.ts providers
bun run src/cli.ts providers --json
```

**`scenarios`** — List available scenarios

```bash
bun run src/cli.ts scenarios
```

### Run Options

| Option                  | Description                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| `-p, --providers <ids>` | Comma-separated provider ids (openai, anthropic, google, openrouter, groq) |
| `-s, --scenario <id>`   | Scenario id (default: basic)                                               |
| `--json`                | Output results as JSON                                                     |
| `-i, --interactive`     | Interactive provider/scenario selection                                    |
| `--requests <n>`        | Number of requests for multi-request scenarios                             |
| `--concurrency <n>`     | Max concurrent requests for shared-trace scenario                          |
| `--trace-id <id>`       | Override trace ID for shared-trace scenarios                               |

### Scenarios

| Id                          | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `basic`                     | Non-streaming + streaming requests (default)               |
| `tools`                     | Tool-calling with `streamText` (Groq)                      |
| `shared-trace-multi-stream` | Multiple concurrent streamed requests sharing one trace ID |

### Shared Trace Multi-Stream

Use `shared-trace-multi-stream` to generate multiple concurrent requests that share a single trace ID. Useful for testing trace correlation and dashboard grouping.

**Single-provider** (multiple requests, one provider):

```bash
bun run src/cli.ts run -p anthropic -s shared-trace-multi-stream --requests 4
```

**Cross-provider** (multiple requests across providers, all under one trace):

```bash
bun run src/cli.ts run -p openai,anthropic,groq -s shared-trace-multi-stream --requests 2
```

The summary includes a "Trace Correlation" block with the trace ID for dashboard lookup.

## Legacy Script Mapping

Existing npm scripts now invoke the CLI:

| Script            | New equivalent                            |
| ----------------- | ----------------------------------------- |
| `test:openai`     | `bun run src/cli.ts run -p openai`        |
| `test:anthropic`  | `bun run src/cli.ts run -p anthropic`     |
| `test:google`     | `bun run src/cli.ts run -p google`        |
| `test:openrouter` | `bun run src/cli.ts run -p openrouter`    |
| `test:groq`       | `bun run src/cli.ts run -p groq`          |
| `test:groq-tools` | `bun run src/cli.ts run -p groq -s tools` |
| `test:all`        | `bun run src/cli.ts run`                  |

## Proxy Path Structure

| Gateway Path                      | Target URL                                                    |
| --------------------------------- | ------------------------------------------------------------- |
| `/openai/v1/chat/completions`     | `https://api.openai.com/v1/chat/completions`                  |
| `/anthropic/v1/messages`          | `https://api.anthropic.com/v1/messages`                       |
| `/google/v1beta/models/...`       | `https://generativelanguage.googleapis.com/v1beta/models/...` |
| `/openrouter/v1/chat/completions` | `https://openrouter.ai/api/v1/chat/completions`               |
| `/groq/v1/chat/completions`       | `https://api.groq.com/openai/v1/chat/completions`             |

## Environment Variables

| Variable                       | Required       | Description                                  |
| ------------------------------ | -------------- | -------------------------------------------- |
| `TRACE_FLOW_API_KEY`           | Yes            | Your proxy gateway API key                   |
| `OPENAI_API_KEY`               | For OpenAI     | OpenAI API key                               |
| `ANTHROPIC_API_KEY`            | For Anthropic  | Anthropic API key                            |
| `GOOGLE_GENERATIVE_AI_API_KEY` | For Google     | Google Gemini API key                        |
| `OPENROUTER_API_KEY`           | For OpenRouter | OpenRouter API key                           |
| `GROQ_API_KEY`                 | For Groq       | Groq API key                                 |
| `PROXY_URL`                    | No             | Proxy URL (default: `http://localhost:8787`) |

## What the Tests Verify

- Request is properly proxied to the provider
- Response is returned correctly
- Token usage is tracked
- Streaming timing (TTFT) is measured
- Trace ID propagation (when using `traceparent` headers)
