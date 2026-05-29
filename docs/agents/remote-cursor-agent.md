# Remote Cursor Agent Handoff

This repo is prepared for Cursor Background Agents working from Linear issues.
Use this document together with `AGENTS.md`; do not treat it as a replacement
for the repo instructions.

## Required Reading Order

1. `AGENTS.md`
2. This file
3. `docs/agents/workflow.md`
4. `docs/agents/skill-usage.md`
5. `docs/agents/autonomous-loop.md`
6. `docs/agents/repo-navigation.md`
7. `CONTEXT.md`
8. `specs/README.md`
9. The Linear issue and any linked ADRs, specs, or runbooks

When a ticket names a specific app/package, read the local README or adjacent
tests/config for that area before editing.

## Environment Setup

Cursor Background Agents use `.cursor/environment.json` and `.cursor/Dockerfile`.
The image pins Node 24 and Bun 1.3.5. The install command is:

```sh
bun install
```

The package manager is pinned in `package.json`.

## Repo-Local Skills

Canonical skill files live under `.agents/skills`, and `.claude/skills` links
to those directories for Claude-compatible runtimes. Remote environments should
preserve those links.

- `.agents/skills/workflow-agent-implement`
- `.agents/skills/workflow-agent-orchestrator`
- `.agents/skills/workflow-agent-review`
- `.agents/skills/workflow-code-review`
- `.agents/skills/workflow-create-pr`
- `.agents/skills/workflow-issue-triage`
- `.agents/skills/workflow-secret-redaction`

Read `docs/agents/workflow/config.md` first for repo-specific values. Use
`workflow-agent-implement` for implementation. Before opening a PR, run or
request `workflow-code-review` as a read-only review pass; it should load
`docs/agents/review-invariants.md` for Trace Flow invariants. Use CodeRabbit
only when the local review recommends escalation or the change is high risk:
auth, authorization, secrets, Tinybird or Convex schema, destructive data
changes, background jobs, concurrency, proxy streaming, public contracts, or
broad refactors.

## Normal Commands

Use focused commands while iterating:

```sh
bun run --filter <package-name> test
bun run --filter <package-name> type-check
bun run knip
```

Before handoff, run the ticket-specific verification and then:

```sh
bun run ci:check
```

Run local stack smoke when the change touches proxy, queue, consumer, API body
retrieval, or shared runtime behavior:

```sh
bun run dev:all
```

The web app requires Convex in a separate terminal:

```sh
bunx convex dev
bun run dev:web
```

## Hosted Secrets And Deploys

Remote Cursor agents should not receive production secrets by default.

Do not run these commands unless the Linear issue explicitly says the required
credentials are available and Isaac has approved the hosted action:

```sh
bun run deploy:dev
wrangler deploy
convex deploy
```

Production deploys are never manual. Merging to `main` triggers GitHub Actions.

Local commands and CI are the default verification path.

## Linear Workflow

Issues live in Linear team `TRA` and the active agent backlog is
`Trace Flow Roadmap`.

Only pick up issues labeled both `ready-for-agent` and `remote-cursor`.

Run at most 3 remote agents in parallel. When 3 are already in flight, leave
additional startable issues queued (in `Todo`, unassigned) until a slot frees;
do not assign a fourth.

If a ticket is missing enough detail to implement safely, do not guess. Add a
Linear comment with the blocker and move or ask for the ticket to be moved to
`needs-info`.

If the ticket requires a product/security decision, leave implementation
untouched and move or ask for the ticket to be moved to `ready-for-human`.

When the orchestrator sends `Changes Requested` feedback, resume the same
Cursor thread, branch, and PR. Read the PR review comments and failed checks,
push fixes to the same PR, rerun the relevant checks, and move the issue back
to `In Review` when ready for another review pass.

## Pull Requests

Create GitHub pull requests ready for review, not draft, unless the Linear issue
explicitly asks for a draft.

The final PR or handoff comment must include:

- Summary of behavior changed.
- Files changed.
- Tests and checks run, with exact command names.
- Review result: local review verdict and CodeRabbit
  `skipped`/`CLI`/`PR review` decision.
- Any checks not run and why.
- Known gaps, follow-up tickets, or blocked hosted verification.
- Linear issue moved to `In Review` once the PR is ready.

Keep the change scoped to the issue. Do not bundle unrelated cleanup into a
remote-agent branch.
