# CLAUDE.md

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

**Why `TraceBatcher` (Durable Object)**: Queue messages fan out across sharded DO instances (`apps/proxy-consumer/src/batcher.ts`). Each shard batches traces (10k rows or 5s) before inserting into Tinybird to amortize ingest cost. A 5-min cron (`*/5 * * * *`) acts as a safety net to flush stale shards — silent-bake scenario where a shard sat unflushed for 51 days is the reason for the alert threshold.

## Development Gotchas

- **`--persist-to` must match** across all workers or R2/KV storage is isolated per worker
- **Queue consumers only work** when workers run together via `bun run dev:all` (or multi `-c` flags). Running separately won't connect the queue.
- **Consumer requires `nodejs_compat`** compatibility flag for OpenTelemetry
- **Web requires Convex** running in a separate terminal (`bunx convex dev --once` for one-shot, or leave running)
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
- **Shared logging**: `@trace-flow/logging` — Axiom-backed logger; wired into worker entries
- **Emails**: `@trace-flow/emails` — React Email templates for transactional mail
- **R2 keys**: `bodies/${requestId}` (single object with request + response)
- **Stream handling**: Always `tee()`, both streams must be consumed
- **Queue consumer**: Must call `message.ack()` after processing
- **OTel**: Consumer uses `@microlabs/otel-cf-workers`
- **Design context**: `docs/adr/` holds ADRs (queue processing, JWT auth, R2 storage, OTel conventions, etc.) — read before refactoring core flow

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

### Issue tracker

Issues live in Linear (team `TRA`), accessed via the `claude.ai_Linear` MCP server. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Session Notes

When a Claude session encounters something confusing or spends significant debugging time, add a note here for future sessions.

<!-- Add session notes below this line -->
