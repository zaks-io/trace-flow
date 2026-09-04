# AGENTS.md

LLM observability platform on Cloudflare Workers. Seven workers: **Proxy** (streaming LLM capture), **Proxy Consumer** (LLM queue to Tinybird), **Agent Ingest** (collector fact intake), **Agent Consumer** (agent queue to Tinybird), **Pipes API** (Tinybird Pipe forwarding), **Raw API** (R2 Body Object retrieval), **Web** (Next.js dashboard via OpenNext).

Docs: [README.md](./README.md) | [SETUP.md](./SETUP.md) | [agents.md](./apps/web/public/agents.md)

## Architecture & Data Flow

### LLM Request Path

1. Proxy receives LLM request via route paths (`/openai/*`, `/anthropic/*`, `/openrouter/*`, `/groq/*`, `/google/*`)
2. `tee()` duplicates request stream — one for proxying, one for R2 capture
3. `TransformStream` captures response chunks while streaming back to client
4. `c.executionCtx.waitUntil()` defers R2 storage + queue enqueue (non-blocking)
5. Proxy Consumer processes queue batches → sends OTel traces to Tinybird
6. Web fetches trace metadata through Pipes API, bodies through Raw API

### Agent Conversation Path

1. Collector (`apps/cli` or `apps/desktop`) parses local agent transcripts into typed facts
2. Collector posts gzip envelopes to Agent Ingest with `X-Trace-Flow-Collector-Secret`
3. Agent Ingest authenticates `COLLECTOR_CREDS`, checks Convex compatibility policy, rate-limits per org, re-redacts excerpts, claims session ownership, and chunks facts onto `AGENT_QUEUE`
4. Agent Consumer prices Agent Message facts via `MODEL_PRICING`, dedupes through `AGENT_FACT_BATCHER`, and writes `agent_*` Tinybird datasources
5. Web `/app/agents` fetches agent metadata from Tinybird using Convex-minted org-scoped JWTs

**Status:** Agent Conversation Analytics is not production-ready until the production gates in `docs/guides/agent-conversation-analytics/ROADMAP.md` are complete.

**Why `tee()`**: CF Workers streams are read-once. Both streams MUST be consumed or the Worker hangs.

**Why `waitUntil()`**: Without it, the Worker terminates before async ops complete → data loss. Response returns immediately for low latency.

## Development Gotchas

- **`--persist-to` must match** across all workers or R2/KV storage is isolated per worker
- **Queue consumers only work** when workers run together via `bun run dev:all` (or multi `-c` flags). Running separately won't connect the queue.
- **Proxy Consumer requires `nodejs_compat`** compatibility flag for OpenTelemetry
- **Web requires Convex** running in a separate terminal (`bunx convex dev`)
- **Agent/local setup is scripted**: run `scripts/dev/start.sh` to create ignored local env files and
  Tinybird Local state, then `scripts/dev/verify.sh` before handoff
- For scripts, bindings, and env details — read `package.json` and `wrangler.toml` files directly
- **Desktop (`apps/desktop`, Tauri):** tray "Quit" calls `app.exit(0)` → fires `RunEvent::ExitRequested { code: Some(_) }`. The run loop must only `prevent_exit()` when `code` is `None` (window-close), else Quit no-ops. "Start at login" writes its own LaunchAgent plist (`src/autostart.rs`) — it MUST include `AssociatedBundleIdentifiers` or macOS won't list it in System Settings → Login Items (looks dead). Verify with `sfltool dumpbtm`, not `osascript` login items (that only lists legacy items). Log level reads from `TRACE_FLOW_LOG`, not `RUST_LOG`. CI builds the `.app` bundle — don't `tauri build` to ship. The engine's syncing/backfilled choices persist in `<app_config_dir>/settings.json` (`src/settings.rs`); never keep sync authorization only in process memory, a relaunch via login autostart silently reset it to paused for a month once. The incremental scan window resumes from the `last_complete_sync_at_ms` cursor-DB watermark, not `now - 24h`.

## Tinybird / ClickHouse

### JWT Auth Flow

1. Frontend requests JWT from Convex action (`api.tinybird.generateToken`)
2. Convex signs JWT with admin token (HS256), includes `fixed_params` (api_keys, retention_days)
3. Frontend calls Pipes API with the JWT; Pipes API forwards it to Tinybird for validation
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
- **OTel**: Proxy Consumer uses `@microlabs/otel-cf-workers`
- **Agent ingest auth**: Collector Credentials are separate from API keys; they live in Convex, sync to `COLLECTOR_CREDS`, and cannot call the Proxy
- **Read-side secret boundary**: `apps/pipes-api` forwards Convex-minted Pipe Tokens and never binds raw-object credentials or `TINYBIRD_ADMIN_TOKEN`; `apps/api` reads Body Objects and never contains Tinybird Pipe forwarding.
- **Agent fact ledger**: `AGENT_FACT_BATCHER` dedupes by stable fact identity before Tinybird insert; same-key changed facts become repair signals
- **Sentry distributed tracing**: Cloudflare Queues carry no headers, so producers copy their trace into the message body as `sentry_trace_context` and consumers `continueTrace` one `queue.process` transaction per producing trace (`@trace-flow/utils/sentry-tracing`). Durable Object RPC needs `enableRpcTracePropagation: true` on both the calling Worker and the DO; the values must match or DO methods see a stray trailing argument. Every Sentry-instrumented Worker sets `tracePropagationTargets` so trace headers never reach LLM providers, Tinybird, or Convex.

## Deployment

**NEVER deploy production manually** — GitHub Actions deploys on merge to `main`. Convex deploys first and exports both `.convex.cloud` and `.convex.site` URLs through `GITHUB_OUTPUT`; Web and Analyst Sandbox consume the `.cloud` URL, while Proxy, Agent Ingest, and MCP consume the `.site` URL. Workers deploy in parallel where their dependencies allow; the Tinybird schema deploys before the proxy/agent consumers (schema → consumers) so a consumer never ships ahead of the live schema.

- Dev deploy: `bun run deploy:dev`
- PRs get automatic preview environments (see `.github/workflows/preview.yml`)

## Testing

- **Standard packages** (utils, types): Vitest with node environment
- **Workers**: `@cloudflare/vitest-pool-workers` — runs tests inside Workers runtime
- Per-package `vitest.config.ts`, Turborepo parallelizes and caches
- Run all: `bun run test` | Watch: `bun run test:watch`
- **Test behavior, not rendered markup.** Do NOT write `renderToStaticMarkup` + `toContain('some text')`
  assertions, or tests that grep a component's source for class names / JSX strings. They are brittle,
  break on every cosmetic change, and verify nothing real. Extract logic into pure functions and unit-test
  those (parsers, reducers, formatters, state machines). UI correctness is verified by running the app, not
  by string-matching HTML.

## Code Style

- Self-documenting code. JSDoc only for "why" (architecture decisions, CF Workers gotchas), never for "what"
- Stale comments are worse than no comments
- Pre-commit runs lint + prettier check; pre-push runs knip, type-check, and tests

## Agent skills

### Agent configuration

Shared agent context lives in `AGENTS.md`, `docs/agents/...`, and
`.agents/skills/...`; update those files first so Claude Code, Codex, and
Cursor stay aligned. Claude Code reads `CLAUDE.md`, which imports `@AGENTS.md`;
do not maintain Claude-specific skill symlinks.

Codex project settings live in `.codex/config.toml` for MCP endpoints and main
config values, and `.codex/hooks.json` for hook wiring and shell commands.
After changing agent config or hooks, restart the relevant agent session so it
reloads the files.

### Workflow skills

Workflow logic lives in the centrally-managed `ziw-*` org skills (pinned in
`skills-lock.json`). Repo-specific values live in
`docs/agents/workflow/config.md` — read it before using any workflow skill.
Core skills: `ziw-orchestrate` (orchestration),
`ziw-implement` (one issue → PR), `ziw-triage` (tracker cleanup),
`ziw-to-issues` (spec/epic → dependency-ordered tickets),
`ziw-code-review` (shared review gate, independent PR review, main-drift review),
`ziw-pr` (PR creation), `ziw-setup` (repo workflow config).

Shared workflow docs:

- `docs/agents/workflow/config.md` — repo workflow lookup table (commands, tracker IDs, labels, gates)
- `docs/agents/workflow.md` — Linear-backed implementation, review, PR, and merge-readiness flow
- `docs/agents/repo-navigation.md` — quick map of apps, packages, specs, ADRs, and workflow files
- `docs/agents/autonomous-loop.md` — state machine for orchestrators and workers
- `docs/agents/skill-usage.md` — which skill to use
- `docs/agents/environment-adapters.md` — Codex, Claude, and Cursor runtime selection
- `docs/agents/remote-cursor-agent.md` — Cursor Background Agent handoff

### Code review

Review happens **locally first** with `ziw-code-review` before any commit
or PR. It should load `docs/agents/review-invariants.md` for the Trace Flow
gotchas (streams, `waitUntil`, queue `ack`, Tinybird/Convex schema, redaction
boundary, required bindings, R2 keys) and the CodeRabbit escalation rubric.

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

- 2026-05-30: **CLOUD-DEV = EVERYTHING IN THE CLOUD. The only local process is the web dev server
  (Next.js on localhost:3000). NO local Workers, NO local data, ever.** When testing the collector (CLI or
  desktop), point it at the **deployed cloud `-dev` ingest Worker** and the **Convex Cloud dev deployment**
  (`TRACE_FLOW_INGEST_URL` = the cloud `-dev` ingest route, `TRACE_FLOW_CONVEX_SITE_URL` = the cloud-dev
  `*.convex.site`). The collector-embedder bakes **production** URLs, so reaching Cloud-Dev REQUIRES these
  overrides; a bare launch hits PROD. Do NOT use `bun run dev:all` Workers on `http://127.0.0.1:8787` as the
  ingest target — that's a LOCAL Worker and is wrong. Check results in CLOUD: `wrangler … --remote`, the
  Cloud Convex dev dashboard, and `/app/agents`. `127.0.0.1` Workers only apply in explicit Self-Contained
  Local / Cursor-mode, which Isaac does NOT want here. See `CONTEXT.md` → Environments.

- 2026-05-28: Agent Conversation Analytics was rebaselined as **not production-ready**. Do not treat
  the Rust collector crates, ignored `headless_e2e` tests, dev-only Cloudflare queue/consumer, manual
  Tinybird deploys, or admin-token/dev-token harnesses as a shipped ingestion product. Production
  readiness requires a normal user-facing collector using Collector Credentials, production
  Cloudflare resources, production Tinybird schema deploy gates, queue/consumer smoke tests, Rust CI,
  live alerts, and truthful `/app/agents` states. See
  `docs/guides/agent-conversation-analytics/ROADMAP.md` and Linear parent `TRA-109`.
