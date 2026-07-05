# Triage Labels

The skills speak in terms of canonical triage and routing roles. This file maps
those roles to the Linear label strings used in this repo. It mirrors the label
section of `docs/agents/workflow/config.md`; that config (verified against live
Linear team `TRA`) is the source of truth.

## Readiness

| Canonical role    | Linear label      | Meaning                                            |
| ----------------- | ----------------- | -------------------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue.           |
| `needs-info`      | `needs-info`      | Waiting on reporter or owner for more information. |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an unattended agent.    |
| `ready-for-human` | `ready-for-human` | Requires human implementation or judgment.         |
| `wontfix`         | `wontfix`         | Will not be actioned.                              |

## Worker environment

| Canonical role  | Linear label    | Meaning                                                       |
| --------------- | --------------- | ------------------------------------------------------------- |
| `remote-cursor` | `remote-cursor` | Safe and intended for Cursor Background Agent implementation. |

## Repo route

| Canonical role | Linear label         | Meaning                                               |
| -------------- | -------------------- | ----------------------------------------------------- |
| repo route     | `zaks-io/trace-flow` | Required so issue-assigned workers resolve this repo. |

## Kind

| Linear label | Meaning                                     |
| ------------ | ------------------------------------------- |
| `kind-spec`  | Spec or PRD container. Never dispatch.      |
| `kind-epic`  | Workstream container. Never dispatch.       |
| `kind-slice` | One-PR implementation ticket. Dispatchable. |

## Risk

| Linear label              | Meaning                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `risk-normal`             | Routine implementation risk.                                   |
| `risk-security-sensitive` | Touches auth, custody, secrets, audit, or authorization.       |
| `risk-schema`             | Changes persistent schema, migrations, RLS, or data contracts. |
| `risk-cross-cutting`      | Touches multiple packages, seams, or workflows.                |

## Type

| Linear label  | Meaning                            |
| ------------- | ---------------------------------- |
| `Bug`         | Defects and issues.                |
| `Feature`     | New functionality.                 |
| `Improvement` | Enhancements to existing features. |
| `Tech Debt`   | Refactoring, cleanup work.         |
| `Spike`       | Research/investigation tasks.      |
| `Hotfix`      | Emergency production fixes.        |

## Review evidence

| Linear label         | Meaning                                                   |
| -------------------- | --------------------------------------------------------- |
| `code-review-passed` | Current linked PR head passed the configured review gate. |

## Estimate

Use the Linear estimate field for `kind-slice` tickets. Valid values are `0`,
`1`, `2`, `4`, `8`, and `16`; split or route to human planning if the work would
exceed `16`.

## Area and ownership

No area or ownership label is configured as workflow authority. Existing labels
such as `frontend`, `research`, and `Launch Blocker` are advisory unless the
issue body or project explicitly makes them part of the route.

When a skill mentions a role, apply the corresponding label in Linear.

Do not substitute a different label silently. If a label does not exist in the
`TRA` team yet, create it on first use.

## Readiness Rules

- `ready-for-agent` means the issue has enough context, acceptance criteria,
  constraints, and verification guidance for an agent to implement one PR.
- `remote-cursor` is an additional routing label. It is never enough by itself;
  Cursor work requires both `ready-for-agent` and `remote-cursor`.
- `zaks-io/trace-flow` is required before issue-assigned delegation.
- `kind-slice` tickets need a Linear estimate before `ready-for-agent`; use the
  scale `0`, `1`, `2`, `4`, `8`, `16`.
- `code-review-passed` must name the reviewed PR URL and head SHA in adjacent
  evidence. Remove it when the PR head changes or blocking findings appear.
- `ready-for-human` means the issue needs product, security, operational, or
  credential judgment before an agent should implement it.
