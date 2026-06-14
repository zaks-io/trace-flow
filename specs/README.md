# Trace Flow Specs

Architectural decisions, technology choices, and contextual information for the Trace Flow LLM observability platform.

## Quick Reference

**What is Trace Flow?** An LLM observability platform that captures requests/responses from AI providers, stores them as OpenTelemetry traces, and displays analytics in a dashboard.

**Core Stack:**

- **Runtime**: Cloudflare Workers (edge deployment)
- **Storage**: R2 (bodies), Tinybird/ClickHouse (traces), Convex (users/config)
- **Queue**: Cloudflare Queues (async processing)
- **Frontend**: Next.js + React + Shadcn + Tailwind
- **Auth**: Auth0 + Convex JWT tokens

**Data Flow:**

```
Client → Proxy Worker → LLM Provider
              ↓
         R2 + Queue
              ↓
   Proxy Consumer Worker
              ↓
      Tinybird otel_*
              ↓
    Web Dashboard ← API Worker (bodies)

Collector CLI/Desktop → Agent Ingest Worker → Agent Queue
                              ↓
                      Agent Consumer Worker
                              ↓
                      Tinybird agent_*
                              ↓
                         /app/agents
```

## Documentation

### Architecture

High-level system design and data models.

- [Overview](architecture/overview.md) - System architecture and data flow
- [Workers](architecture/workers.md) - Worker responsibilities and boundaries
- [Data Model](architecture/data-model.md) - Tinybird + Convex schema decisions

### Decisions

Why we chose specific technologies and patterns.

- [Cloudflare Workers](decisions/cloudflare-workers.md) - Edge-first serverless platform
- [Tinybird Analytics](decisions/tinybird-analytics.md) - Managed ClickHouse for traces
- [Queue-Based Processing](decisions/queue-based-processing.md) - Decoupling proxy from observability
- [R2 Body Storage](decisions/r2-body-storage.md) - Separate storage for request/response bodies
- [OpenTelemetry Conventions](decisions/otel-semantic-conventions.md) - GenAI semantic conventions
- [JWT Tinybird Auth](decisions/jwt-tinybird-auth.md) - Frontend-direct queries with scoped tokens
- [Next.js + OpenNext Frontend](decisions/nextjs-opennext-frontend.md) - Next.js on Cloudflare Workers
- [Proxy KV Caching](decisions/proxy-kv-caching.md) - Two-layer cache for KV/DO cost control

### Components

What each part of the system does.

- [Proxy](components/proxy.md) - Streaming LLM proxy worker
- [Proxy Consumer](components/consumer.md) - LLM trace queue consumer and trace builder
- [Agent Ingest](components/agent-ingest.md) - Collector credential auth, validation, session claims, and queue enqueue
- [Agent Consumer](components/agent-consumer.md) - Agent fact pricing, dedupe, and Tinybird writes
- [API](components/api.md) - Body retrieval service
- [Web](components/web.md) - Dashboard frontend
- [Convex](components/convex.md) - Backend services

### Features

Planned and implemented feature specs.

- [Invite System](features/invite-system.md) - Admin invites and public waitlist
- [Stripe Billing](features/stripe-billing.md) - Subscriptions, payments, and usage billing
- [LLM Usage Reporting](features/llm-usage-reporting.md) - Usage and cost analytics
- [Signup & Onboarding](features/signup-onboarding.md) - User registration flow

### Integrations

How we connect to external services.

- [LLM Providers](integrations/providers.md) - OpenAI, Anthropic, Google, etc.
- [Tinybird](integrations/tinybird.md) - Datasources, pipes, and queries
- [Auth0](integrations/auth0.md) - Authentication flow

## Related Documentation

- [README.md](../README.md) - Project overview and quick start
- [CLAUDE.md](../CLAUDE.md) - Development commands and patterns
- [SETUP.md](../SETUP.md) - Cloudflare resources setup
- [agents.md](../apps/web/public/agents.md) - Integration guide for AI agents
