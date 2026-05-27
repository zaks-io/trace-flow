---
name: trace-flow-implement-issue
description: Implements one ready Trace Flow Linear issue as one scoped branch and PR. Use when working on a Todo TRA issue labeled ready-for-agent, especially delegated agent implementation work.
---

# Trace Flow Implement Issue

Implement one ready Linear issue. Keep the change scoped to that issue and the
repo's current docs.

## Required Context

Read these first:

- `AGENTS.md`
- `docs/agents/workflow.md`
- `docs/agents/repo-navigation.md`
- `docs/agents/autonomous-loop.md`
- `docs/agents/issue-tracker.md`
- `CONTEXT.md`
- `specs/README.md`
- relevant ADRs in `docs/adr/`
- the Linear issue body, comments, labels, dependencies, and linked docs

Cursor workers must also read `docs/agents/remote-cursor-agent.md`.

## Claim

Before editing:

- confirm the issue is in `Todo`, unblocked, scoped to one PR, and labeled
  `ready-for-agent`
- require `remote-cursor` for Cursor Background Agent work
- stop on missing product, security, credential, provider, hosted access, or
  ADR decisions
- move the issue to `In Progress` when claiming it
- include `TRA-<number>` in the branch name when no branch was assigned

## Implementation Rules

- Implement only the issue scope and directly required tests/docs.
- Preserve unrelated user changes in the worktree.
- Read local README, tests, config, or ADR context before editing an area.
- Protect Trace Flow invariants: consume both stream branches, use `waitUntil`
  for deferred capture, ack queue messages after processing, and keep body
  redaction/storage boundaries intact.
- Do not run production deploys manually. Merging to `main` is the production
  deploy path.

## Verification

Run focused checks while iterating. Before handoff, run the checks named by the
issue and `bun run ci:check` unless a narrower gate is justified.

Common checks:

```sh
bun run --filter <package-name> test
bun run --filter <package-name> type-check
bun run knip
bun run ci:check
```

Use local stack verification when the change touches proxy, queue, consumer, API
body retrieval, or shared runtime behavior. Use hosted commands only when the
issue explicitly authorizes credentials and environment access.

## Pre-PR Review

Before opening a PR, run or request `trace-flow-local-code-review` on the local
branch or working-tree diff when the environment supports it. Address blocking
findings before PR handoff.

## PR Handoff

Open a ready-for-review PR, not a draft, unless the issue explicitly asks for a
draft. Use `trace-flow-create-pr` when available.

The handoff must include:

- summary of behavior changed
- files changed
- checks run, with exact command names
- local review verdict and CodeRabbit decision
- checks not run and why
- known gaps, follow-up issues, or blocked hosted verification

Move the Linear issue to `In Review` once the PR is ready. Do not move it to
`Ready to Merge`.

## Changes Requested

When resuming after review feedback:

- continue the same branch and PR
- read PR review comments, failed checks, the Linear issue, and linked docs
- address only requested changes and directly required tests/docs
- push fixes to the same PR
- summarize what changed and which checks were rerun
- move the issue back to `In Review` when fixes are ready
