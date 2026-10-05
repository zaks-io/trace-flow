# Trace Flow Agent Guide

Trace Flow captures model API and coding-agent analytics to track costs and performance.
The hosted service requires an account with access. Coding-agent analytics is available in private alpha.
For your own deployment, see [self-hosted setup](/docs/quick-start#self-hosted-deployments).

Trace Flow has two inputs:

1. The gateway observes an application's model API requests.
2. The local collector observes Claude Code, Codex CLI, and Cursor sessions.

Use the gateway instructions below when the user asks you to integrate Trace Flow into a codebase.
Use the [collector guide](https://trace-flow.dev/docs/collector.md) when the user wants to observe
their coding-agent sessions. Do not confuse a gateway API key with a Collector Credential.

**Gateway:** `https://gateway.trace-flow.dev`  
**API Keys:** https://trace-flow.dev/app/api-keys  
**MCP Server:** `https://mcp.trace-flow.dev/mcp` ([docs](https://trace-flow.dev/docs/mcp))

## Agent Handoff Checklist

When a user asks you to add Trace Flow to a codebase, follow this order:

1. Read this file first, then fetch only the linked docs you need. Establish which deployment the user intends to use before changing configuration. Do not infer permission to send their application data to the hosted service from this guide.
2. Look for an existing local env file (`.env`, `.env.local`, `.dev.vars`, etc.) and add `TRACE_FLOW_API_KEY` there.
3. Keep the upstream provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) configured exactly as the app already expects.
4. Update the app to use the chosen deployment's gateway. `https://gateway.trace-flow.dev/{provider}` is the hosted service.
5. Run one traced request with a synthetic prompt against the chosen deployment and confirm it appears in Trace Flow. Do not use private prompts or transcripts as test data.

## Environment Variables

Always preserve the provider's normal API key and add Trace Flow alongside it.

```bash
TRACE_FLOW_API_KEY=...
OPENAI_API_KEY=...
OPENAI_MODEL=your-openai-model
```

## Quick Start

1. Add header: `X-Trace-Flow-Api-Key: {your-api-key}`
2. Change base URL to `gateway.trace-flow.dev/{provider}`
3. Pass your provider API key as normal

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const openai = createOpenAI({
  baseURL: 'https://gateway.trace-flow.dev/openai/v1',
  apiKey: process.env.OPENAI_API_KEY,
  headers: {
    'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY,
  },
});

const result = await generateText({
  model: openai(process.env.OPENAI_MODEL!),
  prompt: 'Hello',
});
```

## If the repo uses MCP config

When configuring MCP, preserve the existing server entries in `.mcp.json` or the equivalent client config.

For an authorized connection to the hosted service, use the hosted server below. For a fork,
replace the URL with its MCP endpoint. Add an MCP connection when the user asks for it; gateway
integration does not need one.

```json
{
  "trace-flow": {
    "type": "http",
    "url": "https://mcp.trace-flow.dev/mcp"
  }
}
```

If the repo already has MCP server entries, add the `trace-flow` block alongside them rather than replacing the whole file.

For a headless sandbox, create a separate key with **MCP read access** enabled on the API Keys
page. Default keys only allow sending traces. Set the read key through the sandbox's secret
`TRACE_FLOW_API_KEY` environment variable, then configure Codex's `bearer_token_env_var` or
Claude Code's `Authorization: Bearer ${TRACE_FLOW_API_KEY}` header expansion. See the
[MCP setup guide](https://trace-flow.dev/docs/mcp#api-keys-for-sandboxes). Never write the raw
key into a committed config or a command-line argument. MCP access reads the owner's
organization analytics; MCP tools currently have no write operations.

## Providers

| Provider   | Path             |
| ---------- | ---------------- |
| OpenAI     | `/openai/v1`     |
| Anthropic  | `/anthropic/v1`  |
| Google     | `/google/v1beta` |
| OpenRouter | `/openrouter/v1` |
| Groq       | `/groq/v1`       |
| TypeSafe   | `/typesafe/v1`   |

## Jev decisions

Jev accepts application `state` and typed `questions`, then returns `answers` and token usage.
Trace Flow captures these requests as decisions. Use the provider's normal bearer key and the
Trace Flow header. Choose the gateway for the deployment you intend to use.

| API                   | Hosted gateway endpoint                                     | Model example          |
| --------------------- | ----------------------------------------------------------- | ---------------------- |
| TypeSafe System One   | `https://gateway.trace-flow.dev/typesafe/v1/systemone`      | `jev-latest`           |
| OpenRouter System One | `https://gateway.trace-flow.dev/openrouter/v1/systemone`    | `jev-latest`           |
| OpenRouter Decisions  | `https://gateway.trace-flow.dev/openrouter/alpha/decisions` | `~typesafe/jev-latest` |

For plain HTTP, a synthetic TypeSafe request looks like this:

```bash
curl https://gateway.trace-flow.dev/typesafe/v1/systemone \
  -H "Authorization: Bearer ${TYPESAFE_API_KEY}" \
  -H "X-Trace-Flow-Api-Key: ${TRACE_FLOW_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"model":"jev-latest","state":"My subscription was charged twice.","questions":{"refund":{"type":"noul","instructions":"Is the customer asking for money back?"}}}'
```

The same request through OpenRouter's Decisions API uses its namespaced model alias:

```bash
curl https://gateway.trace-flow.dev/openrouter/alpha/decisions \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
  -H "X-Trace-Flow-Api-Key: ${TRACE_FLOW_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"model":"~typesafe/jev-latest","state":"My subscription was charged twice.","questions":{"refund":{"type":"noul","instructions":"Is the customer asking for money back?"}}}'
```

To use OpenRouter's System One endpoint, change the second URL to
`https://gateway.trace-flow.dev/openrouter/v1/systemone` and set `model` to `jev-latest`.

The official [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) accepts
`baseURL` and `defaultHeaders`. Its base URL ends at the provider name because the SDK appends
`/v1/systemone`:

```typescript
import { noul, TypeSafeClient } from '@typesafe-ai/sdk';

const traceFlowKey = process.env.TRACE_FLOW_API_KEY;
if (!traceFlowKey) throw new Error('TRACE_FLOW_API_KEY is required');

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY,
  baseURL: 'https://gateway.trace-flow.dev/typesafe',
  defaultHeaders: { 'X-Trace-Flow-Api-Key': traceFlowKey },
});

const result = await client.systemOne({
  model: 'jev-latest',
  state: 'My subscription was charged twice.',
  questions: { refund: noul('Is the customer asking for money back?') },
});
```

For the [same SDK through OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk),
replace the client configuration with:

```typescript
const openRouterKey = process.env.OPENROUTER_API_KEY;
if (!openRouterKey) throw new Error('OPENROUTER_API_KEY is required');

const client = new TypeSafeClient({
  apiKey: openRouterKey,
  baseURL: 'https://gateway.trace-flow.dev/openrouter',
  defaultHeaders: { 'X-Trace-Flow-Api-Key': traceFlowKey },
});
```

OpenRouter's model-list response differs from the TypeSafe SDK's `models.list()` return type.
Trace Flow preserves that upstream response; use OpenRouter's HTTP model catalog when listing
models through OpenRouter.

Choice answers contain the selected option, option probabilities, and confidence. Score answers
contain the weighted score, legend, probabilities, and confidence. Noul is a probability of yes;
it is not a confidence score. The trace detail panel shows these fields and captured state and
questions when body recording is enabled. Privacy mode retains decision metrics while omitting
these bodies.

Direct TypeSafe costs are estimates from its published rates. OpenRouter can also return a
provider-reported `usage.cost` in USD. Estimated and reported costs are separate trace fields.
Usage aggregates currently round each request to integer microdollars, so tiny Jev charges can
accumulate rounding differences. Output tokens remain visible even when their price is zero.

See the [TypeSafe HTTP API](https://docs.typesafe.ai/api) and
[OpenRouter Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
for current request and response contracts.

## Understanding Trace Context (W3C)

Trace Flow uses [W3C Trace Context](https://www.w3.org/TR/trace-context/).

- Generate a new `trace-id` per user request or turn.
- Reuse the same `trace-id` for all related LLM calls in that request.
- Always generate a new `span-id` for every LLM call.

`traceparent` format:

```text
traceparent: 00-{trace-id}-{span-id}-01
```

## Common mistakes

1. Reusing a span ID across multiple calls (causes overwrites)
2. Reusing a trace ID across separate user requests (traces grow incorrectly)
3. Generating a new trace ID for each LLM call inside one workflow

## Baggage for operation labels

Use [W3C Baggage](https://www.w3.org/TR/baggage/) to pass filterable metadata:

```typescript
headers: {
  traceparent: `00-${traceId}-${generateSpanId()}-01`,
  baggage: "operation=planning,user_id=123,session_id=abc",
}
```

## OpenTelemetry integration

```typescript
import { context, propagation } from '@opentelemetry/api';

const traceHeaders: Record<string, string> = {};
propagation.inject(context.active(), traceHeaders);

await generateText({
  model: openai(process.env.OPENAI_MODEL!),
  prompt: message,
  headers: traceHeaders,
});
```

## What can be tracked

- Token usage reported by the provider, including cached or reasoning tokens where available
- Latency and time to first token for streaming responses
- Model/provider metadata and finish reason
- Request/response bodies when recording is enabled and body storage is not omitted
- Errors and status codes
- Cost estimates

## Coding-agent collector

The collector is a separate local application. It parses supported stores locally, redacts excerpts,
and uploads typed facts with an OS-keychain-backed Collector Credential. It does not send raw
transcripts through the normal analytics path.

Current sources are Claude Code, Codex CLI, and Cursor on macOS. Signed desktop downloads and the CLI
source workflow are documented at <https://trace-flow.dev/docs/collector.md>.

## Privacy mode: skip body storage

```typescript
headers: {
  "X-Trace-Flow-Omit-Body": "true",
}
```

Metrics are still captured; only request and response bodies are omitted.

## Full docs

- https://trace-flow.dev/docs/quick-start
- https://trace-flow.dev/docs/sdk-reference
- https://trace-flow.dev/docs/opentelemetry
- https://trace-flow.dev/docs/collector
- https://trace-flow.dev/docs/mcp
