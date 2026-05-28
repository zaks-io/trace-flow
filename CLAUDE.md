# AGENTS.md

LLM observability platform on Cloudflare Workers. Four workers: **Proxy** (streaming capture), **Consumer** (queue → Tinybird), **API** (R2 body retrieval), **Web** (Next.js dashboard via OpenNext).

Docs: [README.md](./README.md) | [SETUP.md](./SETUP.md) | [agents.md](./apps/web/public/agents.md)

## Architecture & Data Flow

1. Proxy receives LLM request via route paths (`/openai/*`, `/anthropic/*`, `/openrouter/*`, `/groq/*`, `/google/*`)
2. `tee()` duplicates request stream — one for proxying, one for R2 capture
3. `TransformStream` captures response chunks while streaming back to client
4. `c.executionCtx.waitUntil()` defers R2 storage + queue enqueue (non-blocking)
5. Consumer processes queue batches → sends OTel traces to Tinybird
6. Web fetches trace metadata from Tinybird, bodies from API worker

**Why `tee()`**: CF Workers streams are read-once. Both streams MUST be consumed or the Worker hangs.

**Why `waitUntil()`**: Without it, the Worker terminates before async ops complete → data loss. Response returns immediately for low latency.

## Development Gotchas

- **`--persist-to` must match** across all workers or R2/KV storage is isolated per worker
- **Queue consumers only work** when workers run together via `bun run dev:all` (or multi `-c` flags). Running separately won't connect the queue.
- **Consumer requires `nodejs_compat`** compatibility flag for OpenTelemetry
- **Web requires Convex** running in a separate terminal (`bunx convex dev`)
- **Agent/local setup is scripted**: run `scripts/dev/start.sh` to create ignored local env files and
  Tinybird Local state, then `scripts/dev/verify.sh` before handoff
- For scripts, bindings, and env details — read `package.json` and `wrangler.toml` files directly

## Tinybird / ClickHouse

### JWT Auth Flow

1. Frontend requests JWT from Convex action (`api.tinybird.generateToken`)
2. Convex signs JWT with admin token (HS256), includes `fixed_params` (api_keys, retention_days)
3. Frontend calls Tinybird APIs directly with JWT — no backend proxy needed
4. Tokens expire after 10 min, 403 triggers auto-refresh
5. Admin token never exposed to frontend

### Schema Rules

- `LowCardinality(String)` for enums/low-cardinality strings (< 10k unique)
- Avoid `Nullable` — creates extra UInt8 column, degrades performance
- Sorting key order impacts query performance 10-100x. Put highest-cardinality filter columns first
- Use `FORWARD_QUERY` for zero-downtime schema migrations
- Every datasource has a `_quarantine` table for rows that don't match schema
- `.datasource` files live in `datasources/`. Validate with `tb build` before deploy
- Use `--allow-destructive-operations` when deleting datasources

### Query Optimization

1. Filter on sorting key columns first
2. Use `PREWHERE` for high-selectivity filters on small columns (not Strings/Arrays)
3. Run filters before JOINs — use IN to reduce data first
4. Denormalize over joins — ClickHouse favors wide tables
5. GROUP BY and complex operations last

## Important Patterns

- **Shared types**: `@trace-flow/types` — defines contract between workers
- **Shared utils**: `@trace-flow/utils`
- **R2 keys**: `bodies/${requestId}` (single object with request + response)
- **Stream handling**: Always `tee()`, both streams must be consumed
- **Queue consumer**: Must call `message.ack()` after processing
- **OTel**: Consumer uses `@microlabs/otel-cf-workers`

## Deployment

**NEVER deploy production manually** — GitHub Actions deploys on merge to `main`. Order: Convex first → workers in parallel → web after Convex.

- Dev deploy: `bun run deploy:dev`
- PRs get automatic preview environments (see `.github/workflows/preview.yml`)

## Testing

- **Standard packages** (utils, types): Vitest with node environment
- **Workers**: `@cloudflare/vitest-pool-workers` — runs tests inside Workers runtime
- Per-package `vitest.config.ts`, Turborepo parallelizes and caches
- Run all: `bun run test` | Watch: `bun run test:watch`

## Code Style

- Self-documenting code. JSDoc only for "why" (architecture decisions, CF Workers gotchas), never for "what"
- Stale comments are worse than no comments
- Pre-commit runs lint + prettier check; pre-push runs knip, type-check, and tests

## Agent skills

### Agent configuration

Shared agent context lives in `AGENTS.md`, `docs/agents/...`, and
`.agents/skills/...`; update those files first so Claude Code, Codex, and
Cursor stay aligned. Claude-facing redirects under `.claude` point back to the
shared `.agents`, `.codex`, and `AGENTS.md` paths, while `CLAUDE.md` points at
`AGENTS.md`.

Codex project settings live in `.codex/config.toml` for MCP endpoints and main
config values, and `.codex/hooks.json` for hook wiring and shell commands.
After changing agent config or hooks, restart the relevant agent session so it
reloads the files.

Shared workflow docs:

- `docs/agents/workflow.md` — Linear-backed implementation, review, PR, and merge-readiness flow
- `docs/agents/repo-navigation.md` — quick map of apps, packages, specs, ADRs, and workflow files
- `docs/agents/autonomous-loop.md` — state machine for orchestrators and workers
- `docs/agents/skill-usage.md` — which repo-local skill to use
- `docs/agents/environment-adapters.md` — Codex, Claude, and Cursor runtime selection
- `docs/agents/remote-cursor-agent.md` — Cursor Background Agent handoff

### Code review

Review happens **locally first**. Run `trace-flow-local-code-review` for
Linear issue work and `trace-flow-code-review` or `code-review` for generic
diff review before any commit or PR. These carry the bug taxonomy and the Trace
Flow gotchas (streams, `waitUntil`, queue `ack`, Tinybird schema, redaction
boundary). The `trace-flow-create-pr` and compatibility `create-pr` skills wire
this into the PR flow.

CodeRabbit is **on-demand only** — automatic and incremental reviews are disabled in `.coderabbit.yaml`, so the team is never throttled by hosted-review rate limits. Escalate to CodeRabbit (CLI `coderabbit review --agent`, or a `@coderabbitai review` PR comment) only for genuinely high-risk changes per the skill's escalation rubric.

### Issue tracker

Issues live in Linear team `TRA`; the active agent backlog project is
`Trace Flow Roadmap`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label strings (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `remote-cursor`, `wontfix`). See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Session Notes

When a Codex session encounters something confusing or spends significant debugging time, add a note here for future sessions.

<!-- Add session notes below this line -->

- 2026-05-28: Agent Conversation Analytics was rebaselined as **not production-ready**. Do not treat
  the Rust collector crates, ignored `headless_e2e` tests, dev-only Cloudflare queue/consumer, manual
  Tinybird deploys, or admin-token/dev-token harnesses as a shipped ingestion product. Production
  readiness requires a normal user-facing collector using Collector Credentials, production
  Cloudflare resources, production Tinybird schema deploy gates, queue/consumer smoke tests, Rust CI,
  live alerts, and truthful `/app/agents` states. See
  `docs/guides/agent-conversation-analytics/ROADMAP.md` and Linear parent `TRA-109`.
