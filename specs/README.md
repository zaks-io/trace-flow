# Trace Flow Specs

Architectural decisions, technology choices, and contextual information for Trace Flow's model API
and coding-agent observability platform.

## Quick Reference

**What is Trace Flow?** A private-alpha observability platform for proxied model API requests and
locally collected coding-agent sessions. It stores model calls as OpenTelemetry spans and agent
activity as redacted typed facts, then exposes both through the dashboard and MCP.

**Core Stack:**

- **Runtime**: Cloudflare Workers (edge deployment)
- **Storage**: R2 (Body Objects), Tinybird/ClickHouse (traces and agent facts), Convex (control plane)
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
    Web Dashboard ← Pipes API (queries) + Raw API (bodies)

Collector CLI/Desktop → Agent Ingest Worker → Agent Queue
                              ↓
                      Agent Consumer Worker
                              ↓
                      Tinybird agent_*
                              ↓
                         /app/agents

MCP → Convex OAuth → Pipes API → Tinybird
```

`apps/archive-api` is a disabled Conversation Archive authorization scaffold. It has no persistence,
production configuration, or deployed origin.

## Documentation

### Architecture

High-level system design and data models.

- [Overview](architecture/overview.md) - System architecture and data flow
- [Workers](architecture/workers.md) - Worker responsibilities and boundaries
- [Data Model](architecture/data-model.md) - Tinybird + Convex schema decisions

### Decisions

Why we chose specific technologies and patterns.

- [Cloudflare Workers](../docs/adr/0001-cloudflare-workers.md) - Edge-first serverless platform
- [Tinybird Analytics](../docs/adr/0009-tinybird-analytics.md) - Managed ClickHouse for traces
- [Queue-Based Processing](../docs/adr/0007-queue-based-processing.md) - Decoupling proxy from observability
- [R2 Body Storage](../docs/adr/0008-r2-body-storage.md) - Separate storage for request/response bodies
- [OpenTelemetry Conventions](../docs/adr/0005-otel-semantic-conventions.md) - GenAI semantic conventions
- [JWT Tinybird Auth](../docs/adr/0002-jwt-tinybird-auth.md) - Frontend-direct queries with scoped tokens
- [Next.js + OpenNext Frontend](../docs/adr/0004-nextjs-opennext-frontend.md) - Next.js on Cloudflare Workers
- [Proxy KV Caching](../docs/adr/0006-proxy-kv-caching.md) - Two-layer cache for KV/DO cost control

### Components

What each part of the system does.

- [Proxy](components/proxy.md) - Streaming LLM proxy worker
- [Proxy Consumer](components/consumer.md) - LLM trace queue consumer and trace builder
- [Agent Ingest](components/agent-ingest.md) - Collector credential auth, validation, session claims, and queue enqueue
- [Agent Consumer](components/agent-consumer.md) - Agent fact pricing, dedupe, and Tinybird writes
- [API](components/api.md) - Body retrieval service
- [Web](components/web.md) - Dashboard frontend
- [Convex](components/convex.md) - Backend services

Pipes API, MCP, and Analyst Sandbox are implemented services but do not yet have standalone files in
`specs/components/`. Their current boundaries are defined in [CONTEXT.md](../CONTEXT.md),
[AGENTS.md](../AGENTS.md), and the source entrypoints under `apps/`.

### Features

Planned and implemented feature specs.

- [Invite System](features/invite-system.md) - Admin invites and public waitlist
- [Stripe Billing](features/stripe-billing.md) - Subscriptions, payments, and usage billing
- [LLM Usage Reporting](features/llm-usage-reporting.md) - Usage and cost analytics
- [Signup & Onboarding](features/signup-onboarding.md) - User registration flow
- [Agent Analytics Query Engine](features/agent-analytics-query-engine.md) - Generic statistical queries over agent facts
- [Local Agent Monitoring](features/local-agent-monitoring.md) - Near-realtime supervision of concurrent local agents
- [Multi-Org RBAC](features/multi-org-rbac.md) - Organizations, roles, and access control

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
- [Collector guide](../apps/web/public/docs/collector.md) - Desktop/CLI sources, privacy, and status
