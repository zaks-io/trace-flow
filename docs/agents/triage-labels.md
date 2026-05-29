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

When a skill mentions a role, apply the corresponding label in Linear.

Do not substitute a different label silently. If a label does not exist in the
`TRA` team yet, create it on first use.

## Readiness Rules

- `ready-for-agent` means the issue has enough context, acceptance criteria,
  constraints, and verification guidance for an agent to implement one PR.
- `remote-cursor` is an additional routing label. It is never enough by itself;
  Cursor work requires both `ready-for-agent` and `remote-cursor`.
- `ready-for-human` means the issue needs product, security, operational, or
  credential judgment before an agent should implement it.
