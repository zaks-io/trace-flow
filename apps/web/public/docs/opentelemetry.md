# OpenTelemetry

Set up your own tracer for custom spans, events, and attributes, then link LLM calls into the same trace tree.

## 1) Install dependencies

```bash
npm install @opentelemetry/api @opentelemetry/sdk-trace-base \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/resources @opentelemetry/semantic-conventions
```

## 2) Initialize tracer provider

```typescript
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const exporter = new OTLPTraceExporter({
  url: 'https://gateway.trace-flow.dev/v1/traces',
  headers: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY! },
});

const provider = new BasicTracerProvider({
  resource: new Resource({ [ATTR_SERVICE_NAME]: 'my-service' }),
});

provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

export const tracer = trace.getTracer('my-service');
```

## 3) Create hierarchical spans

```typescript
import { context, trace, SpanStatusCode } from '@opentelemetry/api';

async function handleRequest(request: Request) {
  const rootSpan = tracer.startSpan('handle-request');

  return context.with(trace.setSpan(context.active(), rootSpan), async () => {
    rootSpan.addEvent('user.click', { button: 'submit' });

    const httpSpan = tracer.startSpan('fetch-data');
    const data = await fetch('/api/data');
    httpSpan.setAttribute('http.status_code', data.status);
    httpSpan.end();

    const llmSpan = tracer.startSpan('llm-call');
    llmSpan.setAttribute('gen_ai.request.model', 'gpt-5');
    llmSpan.end();

    rootSpan.setStatus({ code: SpanStatusCode.OK });
    rootSpan.end();
    return new Response('OK');
  });
}
```

## 4) Link proxy requests with W3C trace context

```typescript
import { context, propagation, trace } from '@opentelemetry/api';
import { generateText } from 'ai';

async function handleUserRequest(userMessage: string) {
  const parentSpan = tracer.startSpan('handle-user-request');

  return context.with(trace.setSpan(context.active(), parentSpan), async () => {
    const traceHeaders: Record<string, string> = {};
    propagation.inject(context.active(), traceHeaders);

    const result = await generateText({
      model: openai('gpt-5'),
      prompt: userMessage,
      headers: {
        ...traceHeaders,
        baggage: 'session_id=abc123,user_id=user-456',
      },
    });

    parentSpan.end();
    return result.text;
  });
}
```

## 5) Serverless flush pattern

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await handleRequest(request);
    ctx.waitUntil(provider.forceFlush());
    return response;
  },
};
```

## Endpoint reference

- Method: `POST`
- URL: `https://gateway.trace-flow.dev/v1/traces`
- Auth header: `X-Trace-Flow-Api-Key: <your-key>`
- Content-Type: `application/json`
- Max payload: `10MB`
