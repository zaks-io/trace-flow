# OpenTelemetry

Set up your own tracer for custom spans, events, and attributes, then link LLM calls into the same trace tree.

## 1) Install dependencies

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/resources @opentelemetry/semantic-conventions
```

## 2) Initialize tracer provider

```typescript
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const exporter = new OTLPTraceExporter({
  url: 'https://gateway.trace-flow.dev/v1/traces',
  headers: { 'X-Trace-Flow-Api-Key': process.env.TRACE_FLOW_API_KEY! },
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'my-service' }),
  traceExporter: exporter,
});

sdk.start();

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
    llmSpan.setAttribute('gen_ai.request.model', process.env.OPENAI_MODEL!);
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
      model: openai(process.env.OPENAI_MODEL!),
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

## 5) Shut down cleanly

```typescript
process.once('SIGTERM', () => {
  void sdk.shutdown().then(
    () => process.exit(0),
    (error) => {
      console.error('OpenTelemetry shutdown failed', error);
      process.exit(1);
    },
  );
});
```

Initialize this module before application code so libraries acquire the configured global tracer.
For a serverless runtime, use that runtime's supported OpenTelemetry integration and lifecycle hook
instead of copying the Node process example.

## Endpoint reference

- Method: `POST`
- URL: `https://gateway.trace-flow.dev/v1/traces`
- Auth header: `X-Trace-Flow-Api-Key: <your-key>`
- Content-Type: `application/json`
- Max payload: `10MB`
