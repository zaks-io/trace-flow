---
name: trace-flow-next-pr
description: Drives the next Trace Flow Linear issue toward a reviewed PR. Use when asked to pick up the next ready item, implement the next step, run the backlog, or handle review feedback.
---

# Trace Flow Next PR

Use this repo-specific coordinator workflow.

## Quick Start

From the repository root, read `AGENTS.md`, `CONTEXT.md`,
`docs/agents/repo-navigation.md`, `specs/README.md`,
`docs/agents/workflow.md`, `docs/agents/skill-usage.md`,
`docs/agents/autonomous-loop.md`, and `docs/agents/issue-tracker.md` before
choosing work.

Pick the first ready Linear issue in `Trace Flow Roadmap` unless the user names
a different target. Prefer issues in `Todo` labeled `ready-for-agent`; when
delegating to Cursor Background Agents, require both `ready-for-agent` and
`remote-cursor`.

If the selected issue is blocked, missing detail, or marked `ready-for-human` or
`needs-info`, record the exact blocker in Linear and stop or move to the next
issue only when project order, issue text, or user instruction allows it.

## Loop Mode

When asked to run in a loop, process one implementation PR at a time. Start each
iteration by fetching latest `main` and rereading workflow docs. Continue only
after the prior PR is merged, or after the user explicitly says to stack another
PR. Stop on blocked or ambiguous items, failing checks that need external
access, unresolved review disagreement, merge conflicts, or the user's loop
budget.

## Workflow

1. Confirm target scope.
   - Restate the selected Linear issue and why it is next.
   - Fetch the issue, labels, project, dependency state, and comments.
   - Read linked specs, ADRs, and runbook context for that area only.
   - Check `git status --short`; preserve user changes.
2. Create an isolated implementation worktree on the latest base.
   - Run `git fetch --prune origin` first.
   - Create new branches from the fetched default branch, usually `origin/main`.
   - Keep the parent agent as coordinator and spawn exactly one worker in that
     worktree.
3. Delegate implementation.
   - Include the selected issue identifier, issue URL, relevant doc paths,
     worktree path, branch, verification expectations,
     `trace-flow-implement-issue`, and "do not create another worktree."
   - Require a final worker report with changed files, checks run, blockers,
     Linear updates needed, and dirty or clean state.
4. Coordinator review.
   - Inspect status and diff in the worker worktree.
   - Run `trace-flow-local-code-review` before PR creation.
   - Run targeted checks during review, then `bun run ci:check` before PR unless
     clearly infeasible.
5. Open the PR.
   - Use `trace-flow-create-pr` for PR conventions.
   - CodeRabbit is on-demand only. Request it only when local review recommends
     escalation or the change is high risk.
6. Watch the PR process.
   - Use `gh pr checks <pr> --watch --fail-fast --interval 15` for PR checks.
   - Use `gh pr view` and `gh run watch` to inspect review and CI state.
   - For delegated Cursor work, send ordinary review feedback back to the
     original Cursor thread and keep fixes on the same branch and PR.
   - Move Linear through `In Review`, `Changes Requested`, and `Ready to Merge`
     according to `docs/agents/autonomous-loop.md`.

## Subagent Prompt Template

```text
Implement the selected Trace Flow Linear issue in this existing worktree.

Worktree: <WORKTREE_PATH>
Branch: <BRANCH_NAME>
Linear issue: <TRA-123 issue URL and title>

Read AGENTS.md, docs/agents/repo-navigation.md, docs/agents/workflow.md,
docs/agents/skill-usage.md, docs/agents/autonomous-loop.md, CONTEXT.md,
specs/README.md, relevant ADRs, and the full issue description/comments. Use
trace-flow-implement-issue. Implement directly in this worktree; do not create
another worktree or revert unrelated edits. Run relevant checks and bun run
ci:check unless you explain a narrower gate. Run or request
trace-flow-local-code-review before PR handoff. Final report: changed files,
check results, blockers, Linear updates needed, and dirty/clean state.
```

## Completion

Final response must include PR URL, branch, worktree path, selected Linear
issue, verification commands/results, CodeRabbit status, Linear status updates
made or needed, and loop status.
