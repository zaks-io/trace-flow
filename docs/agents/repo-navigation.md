# Repo Navigation

Use this as the first map of the repository before opening broad file searches.
It tells you where concepts live and which source of truth to prefer.

## First Read Path

For most tasks, read in this order:

1. `AGENTS.md` for core architecture, gotchas, deployment rules, and agent
   workflow.
2. `CONTEXT.md` for Trace Flow vocabulary.
3. This file for where code and docs live.
4. `specs/README.md` for feature and component specs.
5. Relevant ADRs in `docs/adr/` for decisions that constrain the work.
6. The Linear issue, PR, or user request that defines the immediate scope.

For agent workflow or Linear work, also read:

- `docs/agents/workflow.md`
- `docs/agents/issue-tracker.md`
- `docs/agents/skill-usage.md`

## Runtime Apps

| Path                  | Purpose                                                                                   | Read when                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/proxy`          | Edge LLM gateway. Handles provider routing, stream capture, R2 writes, and queue enqueue. | Provider proxying, streaming, capture, billing enforcement, body omission.        |
| `apps/proxy-consumer` | Queue consumer and durable batching for trace ingestion into Tinybird.                    | Queue delivery, OpenTelemetry rows, Tinybird writes, batch retries, DLQ behavior. |
| `apps/api`            | Authenticated API for body retrieval and scoped data access.                              | R2 body reads, API auth, JWT boundaries, dashboard API calls.                     |
| `apps/web`            | Next.js dashboard on OpenNext/Workers.                                                    | UI, routes, dashboard data views, auth UX, docs pages.                            |
| `apps/mcp`            | Cloudflare Worker MCP server for agent access to trace data.                              | MCP auth, tool calls, trace-read integration.                                     |
| `apps/agent-ingest`   | Agent conversation ingest worker.                                                         | Local agent transcript upload, ingest validation, queue enqueue.                  |
| `apps/agent-consumer` | Agent conversation queue consumer.                                                        | Agent analytics rows, pricing, transcript fact processing.                        |
| `apps/cli`            | User-facing collector CLI.                                                                | Login, source listing, sync, status, disconnect, release packaging.               |
| `apps/desktop`        | Tauri desktop collector.                                                                  | Tray UX, keychain storage, first-egress gate, desktop sync loop, autostart.       |

## Shared Packages

| Path                        | Purpose                                                      | Read when                                                    |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `packages/types`            | Shared cross-app TypeScript contracts.                       | Worker/API/web contract changes.                             |
| `packages/utils`            | Shared helpers, redaction, auth, and request utilities.      | Common behavior used by multiple apps.                       |
| `packages/llm-providers`    | Provider-specific parsing and token usage extraction.        | OpenAI, Anthropic, Google, OpenRouter, or Groq behavior.     |
| `packages/otel-conventions` | Canonical OTel attribute names and row-building conventions. | Span attributes, Tinybird SQL key consistency, OTel naming.  |
| `packages/spans`            | Span parsing and normalization.                              | Trace detail, span modeling, row transforms.                 |
| `packages/tinybird-client`  | Tinybird insert/query client helpers.                        | Tinybird API calls, retries, insert failures.                |
| `packages/pricing`          | Model pricing and token cost logic.                          | Cost calculation or pricing catalog changes.                 |
| `packages/convex`           | Convex backend, auth/session actions, billing, org state.    | Auth0, Tinybird JWTs, orgs, subscriptions, Stripe, MCP auth. |
| `packages/logging`          | Structured logging helpers.                                  | Log fields, event names, Sentry/Axiom consistency.           |
| `packages/sdk-tests`        | SDK and integration test tooling.                            | End-to-end client or CLI test harness changes.               |
| `packages/collector-*`      | Desktop collector contracts and shared collector code.       | Agent conversation analytics desktop collector work.         |
| `packages/emails`           | Email templates and rendering.                               | User-facing email copy or delivery.                          |

## Data And Query Layer

- `datasources/` contains Tinybird datasource schemas. Validate schema changes
  with Tinybird tooling when the issue requires it.
- `pipes/` contains Tinybird pipe SQL for dashboard, MCP, and alert queries.
- `specs/architecture/data-model.md` explains the high-level data model.
- `docs/adr/0009-tinybird-analytics.md`, `docs/adr/0005-otel-semantic-conventions.md`,
  and `docs/adr/0012-agent-conversation-analytics.md` constrain schema and query
  changes.

Tinybird changes are high risk. Check sorting keys, avoid unnecessary
`Nullable`, preserve quarantine expectations, and keep SQL attribute names in
sync with `packages/otel-conventions`.

## Specs, Decisions, And Guides

- `specs/README.md` is the index for architecture, components, features,
  integrations, security, and cost docs.
- `docs/adr/` records accepted architecture decisions. Surface contradictions
  explicitly before changing behavior.
- `docs/guides/agent-conversation-analytics/` is the execution guide for the
  agent analytics build; its roadmap and changelog matter for that feature.
- `apps/web/public/agents.md` is the public integration guide for users and
  agents calling Trace Flow.

## Agent And Workflow Files

- `AGENTS.md` is the top-level agent instruction file.
- `docs/agents/` contains repo workflow, Linear, triage, domain, and runtime
  handoff docs.
- `.agents/skills/` is the canonical repo-local skill directory.
- `.claude/skills/` should contain symlinks back to `.agents/skills/`.
- `.codex/` contains Codex project configuration and hooks.
- `.cursor/` contains Cursor Background Agent environment and rules.

The `ziw-*` skills are centrally managed and version-pinned in `skills-lock.json`. After
editing agent workflow files, confirm `.claude/skills/<name>` still resolves to
`.agents/skills/<name>` (e.g. `ls -la .claude/skills`).

## CI, Deploy, And Local Runtime

- Environment vocabulary (**Local Workers**, **Cloud-Dev**, **Self-Contained
  Local**, **Control Plane** / **Data Plane**) is defined in the **Environments**
  section of `CONTEXT.md`. `docs/agents/local-environment.md` describes the
  Self-Contained Local stack the dev scripts build by default. Never say "dev"
  unqualified — name which plane points at cloud vs local.
- `package.json` defines root scripts. Use `bun run ci:check` as the full local
  gate unless a narrower check is justified.
- `turbo.json` defines package tasks and caching.
- `.github/workflows/ci.yml` runs checks for PRs.
- `.github/workflows/preview.yml` creates preview environments.
- `.github/workflows/deploy.yml` deploys production on merge to `main`.
- `scripts/ci-check.sh` wraps local CI with safe dummy web env values.

Never deploy production manually. Merging to `main` is the production deploy
path.

## Common Change Routes

- Proxy capture or provider behavior: start in `apps/proxy`, then
  `packages/llm-providers`, `packages/types`, and relevant ADRs.
- Queue processing or trace persistence: start in `apps/proxy-consumer`,
  `packages/otel-conventions`, `packages/spans`, `datasources/`, and `pipes/`.
- Dashboard behavior: start in `apps/web`, then the relevant pipe and
  `packages/convex` action/query.
- Body retrieval: start in `apps/api`, then R2 key rules in `AGENTS.md` and
  body storage ADRs.
- Auth, orgs, billing, or Tinybird JWTs: start in `packages/convex`, then
  `specs/integrations/auth0.md`, `specs/features/stripe-billing.md`, and
  `docs/adr/0002-jwt-tinybird-auth.md`.
- Agent analytics: start in
  `docs/guides/agent-conversation-analytics/README.md`, then its roadmap, ADR,
  `apps/agent-ingest`, `apps/agent-consumer`, and `packages/collector-*`.

## Search Hints

- Prefer `rg` and `rg --files`.
- Search for package names in `package.json` files before guessing ownership.
- For generated files, identify the generator before editing. Avoid editing
  generated Convex files directly.
- For app bindings and environment names, read the relevant `wrangler.toml` or
  `wrangler.jsonc`.
