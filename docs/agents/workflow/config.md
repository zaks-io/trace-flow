# Agent Config

Last updated: 2026-05-28

Workflow lookup table for the `workflow-*` skills. Repo-specific values live here;
workflow logic lives in the centrally-managed org skills pinned by `skills-lock.json`.

## Verification

- Scope: repo identity, commands, Linear tracker metadata, labels, agent access, review gates, environments.
- Evidence sources: `package.json`, `scripts/ci-check.sh`, `wrangler.toml` files, `CLAUDE.md`/`AGENTS.md`, `.claude/`, `.codex/`, git metadata, live Linear MCP queries.
- Safe commands run: `git branch`, `git log`, `jq .scripts package.json`.
- Read-only tool calls: Linear `list_teams`, `list_issue_statuses team=TRA`, `list_issue_labels team=TRA`, `list_projects team=TRA`.
- Inferred values: branch prefix (none enforced — mixed `t3code/`, `agent-analytics-*`, `claude/*`).
- Critical unknowns: issue-assigned coding-agent IDs (Cursor) not probed; see Unknowns.

## Repo

- Name: trace-flow
- Default branch: main
- Branch prefix: none enforced (observed: `t3code/`, `agent-analytics-*`, `claude/*`)
- Package manager: bun (lockfile `bun.lock`)
- Install: `bun install`
- Full local gate: `bun run ci:check` (script `scripts/ci-check.sh`); `bun run check` runs prettier + turbo lint/type-check/test/build
- Focused checks: `bun run lint` | `bun run type-check` | `bun run test` | `bun run knip` | `bun run --filter <pkg> test`
- Build: `bun run build`
- Generated artifacts: none tracked for workflow
- Preview checks: PR preview env via `.github/workflows/preview.yml`
- Production deploy path: GitHub Actions on merge to `main` (Convex first → workers parallel → web)
- Production approval required: yes
- Dev deploy: `bun run deploy:dev`

## Issue Tracker

- Provider: Linear
- Provider location: team `Trace Flow` key `TRA` id `e43310a3-ecb1-42f9-a349-3627820765a2`
- Metadata verified: 2026-05-28 via Linear MCP
- Verified IDs:
  - Project `Trace Flow Roadmap`: `57d323d1-7740-4083-a950-d54288ec16d1` (active)
  - Project `Trace Flow Launch`: `cd017399-0a6c-40bf-a383-54dba9a34e5c` (Completed — do not bulk-migrate)
  - Statuses: Triage `5e725aed…`, Backlog `75c7bc69…`, Todo `0517d226…`, In Progress `d0784639…`, Blocked `4ce9dbb7…`, In Review `955eeb1a…`, Changes Requested `14690ca7…`, Ready to Merge `ec96a72a…`, Done `49e09cde…`, Canceled `a7bc2722…`, Duplicate `ce048fbd…`
- Query-safe names: team key `TRA`; project name `Trace Flow Roadmap`; status names match the contract below
- Read-only verification query: `list_issues team=TRA project="Trace Flow Roadmap"`
- Tracker tool query contract: Linear MCP (`list_issues`, `get_issue`, `save_issue`, `list_issue_labels`, `list_issue_statuses`)
- Status field names: `status` (issue write/read); `state` accepted for project filtering
- Dependency and blocker fields: Linear issue relations (blocks / blocked-by)
- Label source of truth: live Linear team `TRA`; mirrored in `docs/agents/triage-labels.md`
- Label docs: `docs/agents/triage-labels.md` mirrors this config
- Project, board, repo, milestone, or roadmap: project `Trace Flow Roadmap`
- Routing label: `ready-for-agent` (readiness); `remote-cursor` (worker environment)
- Triage scope: `TRA` team, `Trace Flow Roadmap` project
- Orphan policy: route when project/team/parent/label is directly evidenced; otherwise leave in Triage with `needs-info`/`ready-for-human`; never cancel for staleness alone
- Issue key examples: `TRA-112`, `TRA-101`
- Ready state: Todo
- Active states: In Progress, Blocked, In Review, Changes Requested, Ready to Merge
- Done state: Done
- Status transition owner: Agent Orchestrator
- Readiness labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix
- Readiness label policy:
  - ready-for-agent: no further human refinement needed before agent handoff; does not mean unblocked or startable
  - needs-info: waiting on reporter/owner for more information
  - ready-for-human: needs product, security, operational, credential, or ADR judgment before an agent implements
- Worker environment labels: remote-cursor
- Worker environment label policy:
  - remote-cursor: approved + intended for Cursor Background Agent; requires `ready-for-agent` too; does not mean unblocked or startable
- Startable work criteria: Todo, in `Trace Flow Roadmap`, `ready-for-agent`, complete agent-ready body, no active blockers, no active claim or open PR
- Risk labels: risk-normal, risk-security-sensitive, risk-schema, risk-cross-cutting
- Type labels: Bug, Feature, Improvement, Tech Debt, Spike, Hotfix
- Area labels: none (not configured in `TRA`)
- Priority policy: Linear priority field; no agent override without user direction
- Dependency policy: encode order with Linear blocks/blocked-by relations
- Agent-ready issue body: outcome, context docs, in scope, out of scope, acceptance criteria, required checks, security/privacy/data/operational invariants, dependencies or blockers
- Labels are signals, not authority: Linear workflow state is authoritative; Agent Orchestrator owns state transitions

## Work Coordination

- Worker delegation paths: local-worktree, issue-assigned
- Default worker path: local-worktree
- Parallelism policy: one branch/PR per issue; isolated worktree per worker. Max 3 remote/issue-assigned agents running in parallel; queue additional startable work until a slot frees
- Authoritative issue state: Linear
- Authoritative PR state: GitHub
- Authoritative check state: GitHub Actions / CI
- Authoritative deploy state: Cloudflare + Convex (via GitHub Actions)
- Orchestrator mutation authority: Linear workflow status transitions
- Implement authority: one delegated issue → branch → PR
- Review authority: report findings only; no product-code edits, no issue-state moves
- Merge authority: human only. Open a PR to `main`; never autonomous self-merge (merge = ungated prod deploy)
- Claim record: Linear assignment + `In Progress` status + comment
- Orchestrator local state: scratch/checkpoints only, non-authoritative
- Handoff format: Linear issue link + PR link + branch + checks summary + review verdict

## Agent Access

- Local Codex: reads `.agents/skills`; MCP via `.codex/config.toml`; hooks `.codex/hooks.json`
- Issue-assigned agents: Cursor Background Agent via `remote-cursor` label + Linear assignment
- Issue-assigned delegation: Linear assignment to the configured Cursor agent; continue via the same issue comments
- Delegation probe policy: never mutate real implementation issues to discover agents
- Claude: reads `.claude/skills` symlinks → `.agents/skills`
- Claude Code source of truth: `CLAUDE.md` (agent doc); `AGENTS.md` is a symlink to `CLAUDE.md`
- Claude Code imports: `CLAUDE.md` is the agent markdown directly
- Claude Code symlinks: `.claude/skills/<name>` → `../../.agents/skills/<name>`
- Claude Code verification: `ls -la .claude/skills` resolves all entries
- Review model policy: strongest available tier for auth, secrets, schema, queue, stream, public contracts, destructive data; fast models fine for scoped implementation
- Agent Orchestrator: `workflow-agent-orchestrator`
- Agent Review: `workflow-agent-review`
- Agent Implement: `workflow-agent-implement`

## Pull Requests

- PR title: Conventional Commits (`feat(scope): …`, `fix(...)`, `chore(...)`), squash-merged with `(#NN)`
- PR body: summary, linked Linear issue (`TRA-NNN`), checks run, review verdict
- Required checks: `bun run ci:check` / GitHub Actions CI
- Code review: `workflow-code-review` (local-first); repo invariants in `docs/agents/review-invariants.md`
- CodeRabbit: on-demand only (auto + incremental disabled in `.coderabbit.yaml`); escalate per `review-invariants.md` rubric
- Issue update: attach PR to Linear issue, move to `In Review`
- Merge authority: human only

## Environments

- Local: self-contained (Cursor-mode) OR cloud-dev (local workers → cloud data) — two modes
- Local commands: `bun run dev:setup` (start.sh), `bun run dev:all`, `bunx convex dev`, `bun run dev:verify`, `bun run dev:smoke`
- Local services: proxy, consumer, api, web (OpenNext), Convex, Tinybird Local
- Development: may use cloud backing services while app runs locally
- Development backing services: Convex (`bunx convex dev --once`), Tinybird, Cloudflare dev resources
- Preview: PR-scoped via `.github/workflows/preview.yml`
- Preview purpose: review a change in a deployed environment
- Production: explicit approval required
- Production forbidden without approval: any manual deploy; `convex deploy` is hook-blocked — use `bunx convex dev --once`
- Hosted checks allowed without approval: CI, preview deploy on PRs
- Hosted checks requiring approval: production deploy (GitHub Actions on merge to `main`)

## Repo-specific review invariants

See `docs/agents/review-invariants.md` — CF Workers stream/`tee()`/`waitUntil`, queue `ack`,
Tinybird/Convex schema and auth, secret-redaction boundary, required bindings, R2 key format,
and the CodeRabbit escalation rubric. `workflow-code-review` should load it for this repo.

## Unknowns

- [ ] Issue-assigned Cursor agent account ID — verify from a real Linear delegation event during the next Orchestrator run (read-only); do not probe by assigning a live issue.
