# Autonomous Agent Loop

This is the state contract for agents running Trace Flow backlog work. Use it
with `docs/agents/workflow.md`.

## Queue

The queue is Linear team `TRA`, project `Trace Flow Roadmap`.

Agent-ready work must be:

- in `Todo`
- labeled `ready-for-agent`
- unblocked
- scoped to one PR
- backed by enough acceptance criteria to verify completion
- free of unresolved product, security, credential, provider, or ADR decisions

Cursor work must also be labeled `remote-cursor`.

## Orchestrator Loop

On each run:

1. Read `AGENTS.md`, `docs/agents/workflow.md`,
   `docs/agents/issue-tracker.md`, `docs/agents/skill-usage.md`, and
   `docs/agents/environment-adapters.md`.
2. List active Linear issues in `Todo`, `In Progress`, `Blocked`,
   `In Review`, `Changes Requested`, and `Ready to Merge`.
3. Check PR state for active work before starting new work.
4. Select the next issue by project order, priority, dependency state, risk,
   and file/package contention.
5. Choose the executor from `docs/agents/environment-adapters.md`.
6. Build a worker prompt package with the issue, linked docs, required checks,
   branch expectation, and explicit stop conditions.
7. Record delegation in Linear when a worker is assigned.
8. Watch for PRs, failed checks, stale branches, blockers, and review comments.
9. Update Linear using the state contract below.

## Worker Loop

Workers should:

1. Read required context and the assigned Linear issue.
2. Confirm the issue is ready for that runtime.
3. Claim the issue and move it to `In Progress`.
4. Create or use one branch for the issue. Include `TRA-<number>` in the
   branch name when the orchestrator did not assign a branch.
5. Implement only the stated scope.
6. Run ticket-specific checks first, then broader checks as needed.
7. Run or request `trace-flow-local-code-review` before PR handoff.
8. Open a ready-for-review PR, link the Linear issue, and move the issue to
   `In Review`.

## Review And Fix Loop

The orchestrator owns the review/fix loop. It should review PRs from an
isolated local worktree or review subagent, then route actionable feedback
through normal GitHub PR review comments.

When review finds actionable implementation feedback:

1. Post detailed findings on the PR.
2. Move the Linear issue to `Changes Requested`.
3. Return to the original worker thread whenever possible so the same remote
   environment, branch, and PR can continue.
4. Tell the worker which PR comments, failed checks, acceptance gaps, and
   invariant concerns must be addressed.
5. After the worker pushes fixes, rerun review from a clean local worktree.
6. Move the issue back to `In Review` for another review pass, then to
   `Ready to Merge` only after review and required checks are clean.

The orchestrator should not become the local implementer for ordinary review
feedback unless the original worker thread is unavailable or a human redirects
the work.

## Linear State Contract

| State               | Agent behavior                                                        |
| ------------------- | --------------------------------------------------------------------- |
| `Triage`            | Ask or comment for missing intent; do not implement.                  |
| `Backlog`           | Leave queued unless explicitly promoted.                              |
| `Todo`              | Eligible only when labels, dependencies, and body detail are ready.   |
| `In Progress`       | Active implementation. Do not take over without assignment.           |
| `Blocked`           | Comment with the blocker; do not improvise around missing decisions.  |
| `In Review`         | PR opened and ready for review.                                       |
| `Changes Requested` | Review found actionable feedback; continue on the same branch and PR. |
| `Ready to Merge`    | Review is clean and required checks pass.                             |
| `Done`              | Complete. Do not modify without a follow-up issue.                    |
| `Canceled`          | Closed intentionally. Do not modify.                                  |
| `Duplicate`         | Use the canonical issue.                                              |

## Stop Conditions

Stop and ask for human input when work needs:

- product scope not captured in the issue
- a new or changed security posture
- credentials, provider approval, or hosted production access
- an ADR decision or contradiction
- destructive data changes not explicitly requested
- a merge, deploy, or production smoke that has not been authorized
