# Issue Tracker: Linear

Issues and PRDs for this repo live in Linear. Use the Linear tools available in
the current runtime for all operations.

## Team And Project

- Identifier prefix: `TRA-` (for example, `TRA-92`).
- Team: `Trace Flow` (`TRA`).
- Active agent backlog project: `Trace Flow Roadmap`.
- Older launch work may remain in `Trace Flow Launch`; do not bulk-migrate it
  as part of ordinary workflow setup.

Unless the user names a different team, create and look up issues under `TRA`.

## Conventions

- Create an issue with `team` set to `TRA`.
- Set `project` to `Trace Flow Roadmap` for new agent-backlog work.
- Use a short, imperative title.
- Use a markdown description with acceptance criteria, repro steps, links, and
  known constraints.
- Use labels from [triage-labels.md](./triage-labels.md).
- Use real newlines in markdown content, not literal `\n` escape sequences.

For tracer-bullet vertical slices from `/to-issues`, create one Linear issue per
slice and link them as related or as sub-issues of a parent if the user asks for
that shape.

## Reading And Updating Issues

- Look up by ID (`TRA-123`) with the Linear tools.
- Read comments when conversation history matters.
- Apply or remove labels by passing the full intended label set when the tool
  replaces labels.
- Link a ready PR to the issue through Linear links/attachments when available.
  The GitHub integration may also link from branch names and PR bodies.

## Workflow States

The shared state contract lives in `docs/agents/workflow.md` and
`docs/agents/autonomous-loop.md`.

Use these state meanings:

| State               | Meaning                                                         |
| ------------------- | --------------------------------------------------------------- |
| `Triage`            | Needs intake before implementation.                             |
| `Backlog`           | Captured work, not yet agent-ready.                             |
| `Todo`              | Ready queue or selected backlog.                                |
| `In Progress`       | Active implementation.                                          |
| `Blocked`           | Cannot continue until a blocker is resolved.                    |
| `In Review`         | PR is open and ready for review.                                |
| `Changes Requested` | PR has actionable feedback; continue on the same branch and PR. |
| `Ready to Merge`    | Required checks and review are clean.                           |
| `Done`              | Completed.                                                      |
| `Canceled`          | Closed without completion.                                      |
| `Duplicate`         | Closed as duplicate.                                            |

If `Changes Requested` or `Ready to Merge` is not configured in Linear, leave
the issue in `In Review`, add a comment identifying the requested change or
clean-review state, and ask the human operator to add or map the state before
relying on it.

## Agent-Ready Work

Only claim an issue when it is:

- in `Todo`
- in `Trace Flow Roadmap`
- labeled `ready-for-agent`
- unblocked
- scoped to one PR
- backed by enough acceptance criteria to verify completion

Cursor Background Agent work must also be labeled `remote-cursor`.

## When a skill says "publish to the issue tracker"

Create a Linear issue in the `TRA` team.

## When a skill says "fetch the relevant ticket"

Fetch the issue by identifier, for example `TRA-123`, and read comments when
history matters.

## When Linear Is Unreachable

Do not silently fall back to GitHub Issues or local markdown. Surface the
failure and pause the workflow. Issues are the source of truth for triage state;
writing them somewhere else creates drift.
