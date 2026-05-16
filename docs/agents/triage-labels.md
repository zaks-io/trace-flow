# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual Linear label strings used in this repo.

| Canonical role    | Linear label      | Meaning                                  |
| ----------------- | ----------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation            |
| `wontfix`         | `wontfix`         | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), apply the corresponding label in Linear via the MCP server.

If a label doesn't exist in the `TRA` team yet, create it on first use (Linear MCP supports label creation). Don't substitute a different label silently.
