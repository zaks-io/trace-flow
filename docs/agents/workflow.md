# Agent Workflow

This is the shared workflow for Codex, Claude, Cursor, and any future agent
runtime working in this repository. Runtime-specific files should adapt this
workflow, not replace it.

## Entrypoints

Start with:

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/agents/repo-navigation.md`
4. `specs/README.md`
5. `docs/agents/skill-usage.md`
6. `docs/agents/issue-tracker.md`
7. Relevant ADRs in `docs/adr/`

Use `docs/agents/remote-cursor-agent.md` for Cursor Background Agent handoff.

## Workflow

Work moves through six stages.

1. Roadmap and readiness

   Linear is the source of queued work. Use team `TRA` and the
   `Trace Flow Roadmap` project from `docs/agents/issue-tracker.md`.
   Agent-ready tickets must be scoped to one PR, unblocked, have acceptance
   criteria, and be labeled `ready-for-agent`. Cursor work must also be
   labeled `remote-cursor`.

2. Implementation

   Use `workflow-agent-implement` for one Linear issue and one branch. The
   worker claims the issue, moves it to `In Progress`, implements only the
   stated scope, and runs ticket-specific checks.

3. Pre-PR local review

   Use `workflow-code-review` before opening a PR. This catches scope drift,
   missing acceptance criteria, weak tests, Trace Flow invariant gaps (see
   `docs/agents/review-invariants.md`), debug output, and unrelated cleanup
   while the issue is still `In Progress`.

4. PR handoff

   Use `workflow-create-pr` after local review is clean. PRs should be ready
   for review, include the Linear issue, summarize checks, and move the issue
   to `In Review`.

5. PR review and fix loop

   Use `workflow-agent-review` to review the PR against the Linear issue,
   acceptance criteria, Trace Flow invariants, tests, and docs. If review finds
   actionable feedback, post it on the PR, move Linear to `Changes Requested`,
   and send the original worker thread back to the same branch and PR.

6. Orchestration

   Use `workflow-agent-orchestrator` when coordinating multiple issues, worker
   runs, PR checks, and review loops. The orchestrator selects ready work,
   chooses the runtime, delegates with a complete prompt package, watches PRs,
   routes feedback, and escalates human decisions.

## Orchestrator Review Loop

For delegated implementation work:

1. Assign a ready Linear issue to a worker. Cursor Composer is appropriate for
   isolated, well-scoped implementation tickets when the remote environment can
   run the needed checks.
2. The worker implements on one branch and runs required checks.
3. Before PR handoff, the branch gets a local review pass with
   `workflow-code-review` where the environment supports it.
4. The worker opens a ready-for-review PR, links Linear, and moves the issue to
   `In Review`.
5. The orchestrator checks out the PR in a clean local worktree and reviews it
   with `workflow-agent-review`.
6. Review findings are posted as normal GitHub PR review comments.
7. If changes are needed, Linear moves to `Changes Requested`.
8. The orchestrator replies in the original worker thread with the PR feedback,
   failed checks, acceptance gaps, and invariant concerns to address.
9. The worker pushes fixes to the same PR.
10. The orchestrator repeats clean-worktree review until checks and review are
    clean.
11. The issue moves to `Ready to Merge` only when required checks pass and the
    review gate is clean.

The orchestrator should route ordinary fixes back to the assigned worker. It
should not become the implementer for a stuck PR unless the original thread is
unavailable or a human redirects the work.

Implementation and review have different defaults. Fast worker models are fine
for well-scoped implementation. PR review should use the strongest available
review tier, especially for auth, secrets, schema changes, queue behavior,
stream handling, public contracts, and destructive data paths.

## Status Contract

Use the configured Linear workflow state with these meanings:

| State               | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `Triage`            | Needs intake. Do not implement until clarified and moved forward.        |
| `Backlog`           | Captured work, not yet agent-ready.                                      |
| `Todo`              | Ready queue. Claim only when labels, blockers, and body detail allow it. |
| `In Progress`       | Someone is actively implementing. Do not take over without assignment.   |
| `Blocked`           | Cannot continue until the blocker is resolved.                           |
| `In Review`         | PR is open and ready for review.                                         |
| `Changes Requested` | PR has actionable feedback; continue on the same branch and PR.          |
| `Ready to Merge`    | Required checks and review are clean.                                    |
| `Done`              | Completed. Do not modify without a follow-up issue.                      |
| `Canceled`          | Intentionally closed without completion.                                 |
| `Duplicate`         | Closed as duplicate. Use the canonical issue instead.                    |

If a state is not configured in Linear, use the closest configured state only
after saying which mapping is being used.
